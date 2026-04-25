from __future__ import annotations

import asyncio
import base64
import binascii
import concurrent.futures
import logging
import time
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from functools import partial
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .camera import CameraReader, FrameBuffer, detect_camera_sources
from .config import Settings
from .interaction_worker import (
    FIRST_PERSON_INTERACTION_QUESTION,
    InteractionWorker,
    _build_first_person_analysis_record,
    _normalize_prediction,
)
from .llm import JsonLlmClient, build_llm_client
from .prompts import interaction_prompt
from .scene_worker import GlobalSceneWorker
from .storage import JsonlStore
from .utils import frame_to_jpeg_bytes
from .yolo_worker import InterestObjectState, YoloWorker

logger = logging.getLogger(__name__)


class CameraSourceRequest(BaseModel):
    source: str
    width: int | None = Field(default=None, ge=160, le=7680)
    height: int | None = Field(default=None, ge=120, le=4320)


class CameraResolutionRequest(BaseModel):
    width: int | None = Field(default=None, ge=160, le=7680)
    height: int | None = Field(default=None, ge=120, le=4320)


class BrowserFrameRequest(BaseModel):
    source: str
    image: str


@dataclass(slots=True)
class Runtime:
    settings: Settings
    frame_buffer: FrameBuffer
    preview_frame_buffer: FrameBuffer
    camera_reader: CameraReader
    object_state: InterestObjectState
    yolo_worker: YoloWorker
    scene_worker: GlobalSceneWorker
    interaction_worker: InteractionWorker
    scene_store: JsonlStore
    prediction_store: JsonlStore
    first_person_analysis_store: JsonlStore
    llm: JsonLlmClient
    preview_executor: concurrent.futures.ThreadPoolExecutor
    tasks: list[asyncio.Task[Any]]
    observation_generation: int = 0


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime = _build_runtime(settings)
        app.state.runtime = runtime
        runtime.tasks = [
            asyncio.create_task(
                runtime.camera_reader.run(
                    runtime.preview_frame_buffer,
                    analysis_frame_buffer=runtime.frame_buffer,
                ),
                name="camera",
            ),
            asyncio.create_task(runtime.yolo_worker.run(runtime.frame_buffer), name="yolo"),
            asyncio.create_task(
                runtime.scene_worker.run(runtime.frame_buffer),
                name="global-scene",
            ),
            asyncio.create_task(runtime.interaction_worker.run(), name="interaction"),
        ]
        for task in runtime.tasks:
            task.add_done_callback(_log_background_task_result)
        logger.info("interaction predictor started")
        try:
            yield
        finally:
            for task in runtime.tasks:
                task.cancel()
            await asyncio.gather(*runtime.tasks, return_exceptions=True)
            await runtime.llm.close()
            runtime.camera_reader.close()
            runtime.preview_executor.shutdown(wait=False, cancel_futures=True)
            logger.info("interaction predictor stopped")

    app = FastAPI(
        title="Interaction Predictor MVP",
        version="0.1.0",
        lifespan=lifespan,
    )
    web_dir = Path(__file__).resolve().parent / "web"
    if web_dir.exists():
        app.mount("/ui", StaticFiles(directory=web_dir), name="ui")

    @app.get("/", include_in_schema=False)
    async def index() -> FileResponse:
        return FileResponse(web_dir / "index.html")

    @app.get("/health")
    async def health() -> dict[str, Any]:
        runtime = _runtime(app)
        analysis_frame = await runtime.frame_buffer.latest()
        preview_frame = await runtime.preview_frame_buffer.latest()
        return {
            "ok": True,
            "camera": runtime.camera_reader.status,
            "latest_frame": (
                {
                    "frame_id": analysis_frame.frame_id,
                    "timestamp": analysis_frame.timestamp,
                    "source": analysis_frame.source,
                }
                if analysis_frame
                else None
            ),
            "latest_preview_frame": (
                {
                    "frame_id": preview_frame.frame_id,
                    "timestamp": preview_frame.timestamp,
                    "source": preview_frame.source,
                }
                if preview_frame
                else None
            ),
            "yolo": runtime.object_state.health,
            "scene_worker": runtime.scene_worker.health,
            "interaction_worker": runtime.interaction_worker.health,
            "tasks": [_task_status(task) for task in runtime.tasks],
            "config": {
                "camera_url": runtime.settings.camera_url,
                "camera_probe_count": runtime.settings.camera_probe_count,
                "camera_demo_video_path": str(runtime.settings.camera_demo_video_path),
                "camera_width": runtime.settings.camera_width,
                "camera_height": runtime.settings.camera_height,
                "camera_resolution": await runtime.camera_reader.get_resolution(),
                "stream_fps": runtime.settings.stream_fps,
                "analysis_fps_limit": runtime.settings.analysis_fps_limit,
                "analysis_max_side": runtime.settings.analysis_max_side,
                "llm_provider": runtime.settings.llm_provider,
                "llm_model": runtime.settings.active_model,
                "kimi_base_url": runtime.settings.kimi_base_url,
                "kimi_model": runtime.settings.kimi_model,
                "kimi_vision_model": runtime.settings.kimi_vision_model,
                "ollama_base_url": runtime.settings.ollama_base_url,
                "ollama_model": runtime.settings.ollama_model,
                "ollama_vision_model": runtime.settings.ollama_vision_model,
                "scene_input_mode": runtime.settings.scene_input_mode,
                "scene_interval_sec": runtime.settings.scene_interval_sec,
                "interest_stable_duration_sec": runtime.settings.interest_stable_duration_sec,
                "interest_stable_match_ratio": runtime.settings.interest_stable_match_ratio,
                "interest_stable_min_samples": runtime.settings.interest_stable_min_samples,
                "yolo_model": runtime.settings.yolo_model,
                "yolo_fps": runtime.settings.yolo_fps,
            },
        }

    @app.get("/latest-scene")
    async def latest_scene() -> dict[str, Any] | None:
        return _runtime(app).scene_store.latest()

    @app.get("/latest-interest-object")
    async def latest_interest_object() -> dict[str, Any] | None:
        return await _runtime(app).object_state.latest_interest_object()

    @app.get("/latest-prediction")
    async def latest_prediction() -> dict[str, Any] | None:
        return _runtime(app).prediction_store.latest()

    @app.get("/latest-first-person-analysis")
    async def latest_first_person_analysis() -> dict[str, Any] | None:
        return _runtime(app).first_person_analysis_store.latest()

    @app.post("/first-person-analysis")
    async def first_person_analysis(
        require_stable: bool = Query(
            True,
            description="True 时只分析最近稳定停留的中心兴趣物；False 时使用当前最新兴趣物。",
        ),
        include_prompt: bool = Query(True, description="是否在响应中返回实际发送给大模型的 prompt。"),
        persist: bool = Query(True, description="是否把本次按需分析结果写入独立 JSONL 历史。"),
    ) -> dict[str, Any]:
        runtime = _runtime(app)
        generation = runtime.observation_generation
        source_at_request = await runtime.camera_reader.get_source()
        scene = runtime.scene_store.latest()
        if scene is None:
            raise HTTPException(status_code=409, detail="no scene observation available yet")

        if require_stable:
            interest_object = await runtime.object_state.latest_stable_interest_object(
                min_duration_sec=runtime.settings.interest_stable_duration_sec,
                min_match_ratio=runtime.settings.interest_stable_match_ratio,
                min_samples=runtime.settings.interest_stable_min_samples,
            )
        else:
            interest_object = await runtime.object_state.latest_interest_object()
        if interest_object is None:
            detail = (
                "no stable interest object available yet"
                if require_stable
                else "no interest object available yet"
            )
            raise HTTPException(status_code=409, detail=detail)

        prompt = interaction_prompt(scene, interest_object)
        raw = await asyncio.wait_for(
            runtime.llm.generate_json(prompt, max_tokens=700),
            timeout=runtime.settings.llm_timeout_sec,
        )
        if generation != runtime.observation_generation:
            raise HTTPException(status_code=409, detail="observation state changed during analysis")
        prediction = _normalize_prediction(
            raw=raw,
            scene=scene,
            interest_object=interest_object,
        )
        prediction_json = prediction.model_dump(mode="json")
        analysis_json = _build_first_person_analysis_record(
            prediction=prediction,
            scene=scene,
            interest_object=interest_object,
            prompt=prompt,
            raw=raw,
            require_stable=require_stable,
            trigger="manual_api",
            source=source_at_request,
        )
        if persist:
            runtime.first_person_analysis_store.append(analysis_json)

        return {
            "ok": True,
            "mode": "first_person_interaction",
            "question": FIRST_PERSON_INTERACTION_QUESTION,
            "require_stable": require_stable,
            "persisted": persist,
            "prompt": prompt if include_prompt else None,
            "scene": scene,
            "interest_object": interest_object,
            "raw_llm_output": raw,
            "prediction": prediction_json,
            "analysis": analysis_json if include_prompt else {**analysis_json, "prompt": None},
        }

    @app.get("/history/scenes")
    async def scene_history(limit: int = Query(20, ge=1, le=200)) -> list[dict[str, Any]]:
        return _runtime(app).scene_store.read_tail(limit)

    @app.get("/history/predictions")
    async def prediction_history(limit: int = Query(20, ge=1, le=200)) -> list[dict[str, Any]]:
        return _runtime(app).prediction_store.read_tail(limit)

    @app.get("/history/first-person-analyses")
    async def first_person_analysis_history(
        limit: int = Query(20, ge=1, le=200),
    ) -> list[dict[str, Any]]:
        return _runtime(app).first_person_analysis_store.read_tail(limit)

    @app.get("/camera/source")
    async def camera_source() -> dict[str, Any]:
        runtime = _runtime(app)
        return {
            "source": await runtime.camera_reader.get_source(),
            "resolution": await runtime.camera_reader.get_resolution(),
            "status": runtime.camera_reader.status,
        }

    @app.post("/camera/source")
    async def set_camera_source(request: CameraSourceRequest) -> dict[str, Any]:
        runtime = _runtime(app)
        source = request.source.strip()
        if not source:
            raise HTTPException(status_code=400, detail="source must not be empty")
        resolution_provided = bool({"width", "height"} & request.model_fields_set)
        resolution = (
            _request_resolution(request.width, request.height) if resolution_provided else None
        )
        result = await runtime.camera_reader.set_source(
            source,
            resolution=resolution,
            resolution_provided=resolution_provided,
        )
        if result.get("changed"):
            await _reset_observation_state(runtime)
        return {"ok": True, **result}

    @app.get("/camera/resolution")
    async def camera_resolution() -> dict[str, Any]:
        runtime = _runtime(app)
        return {
            "resolution": await runtime.camera_reader.get_resolution(),
            "status": runtime.camera_reader.status,
        }

    @app.post("/camera/resolution")
    async def set_camera_resolution(request: CameraResolutionRequest) -> dict[str, Any]:
        runtime = _runtime(app)
        resolution = _request_resolution(request.width, request.height)
        result = await runtime.camera_reader.set_resolution(resolution)
        if result.get("changed"):
            await _reset_observation_state(runtime)
        return {"ok": True, **result}

    @app.post("/camera/browser-frame")
    async def ingest_browser_frame(request: BrowserFrameRequest) -> dict[str, Any]:
        runtime = _runtime(app)
        try:
            image = await asyncio.to_thread(_decode_browser_frame, request.image)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        accepted = await runtime.camera_reader.ingest_browser_frame(
            source=request.source.strip(),
            image=image,
            preview_frame_buffer=runtime.preview_frame_buffer,
            analysis_frame_buffer=runtime.frame_buffer,
        )
        return {"ok": accepted, "accepted": accepted, "source": request.source.strip()}

    @app.get("/camera/sources")
    async def camera_sources() -> dict[str, Any]:
        runtime = _runtime(app)
        current_source = await runtime.camera_reader.get_source()
        sources = await asyncio.to_thread(
            detect_camera_sources,
            max_index=runtime.settings.camera_probe_count,
            demo_video_path=runtime.settings.camera_demo_video_path,
            current_source=current_source,
        )
        return {
            "current_source": current_source,
            "resolution": await runtime.camera_reader.get_resolution(),
            "sources": [asdict(item) for item in sources],
        }

    @app.get("/snapshot")
    async def snapshot() -> Response:
        frame = await _runtime(app).preview_frame_buffer.latest()
        if frame is None:
            return Response(status_code=404, content=b"no frame available")
        content = await asyncio.to_thread(frame_to_jpeg_bytes, frame.image)
        return Response(content=content, media_type="image/jpeg")

    @app.get("/stream.mjpg", include_in_schema=False)
    async def stream_mjpg(
        fps: float | None = Query(None, ge=1.0, le=30.0),
    ) -> StreamingResponse:
        runtime = _runtime(app)
        stream_fps = fps or runtime.settings.stream_fps
        return StreamingResponse(
            _mjpeg_frame_generator(runtime, fps=stream_fps),
            media_type="multipart/x-mixed-replace; boundary=frame",
            headers={
                "Cache-Control": "no-cache, no-store, must-revalidate",
                "Pragma": "no-cache",
            },
        )

    return app


async def _mjpeg_frame_generator(runtime: Runtime, *, fps: float):
    last_frame_id = -1
    delay = 1.0 / max(1.0, min(30.0, fps))
    loop = asyncio.get_running_loop()
    while True:
        started_at = time.monotonic()
        frame = await runtime.preview_frame_buffer.latest()
        if frame is None or frame.frame_id == last_frame_id:
            await asyncio.sleep(0.03)
            continue
        last_frame_id = frame.frame_id
        try:
            jpeg = await loop.run_in_executor(
                runtime.preview_executor,
                partial(frame_to_jpeg_bytes, frame.image, quality=82),
            )
        except Exception:  # noqa: BLE001
            logger.exception("failed to encode mjpeg frame")
            await asyncio.sleep(delay)
            continue
        yield (
            b"--frame\r\n"
            b"Content-Type: image/jpeg\r\n"
            b"Cache-Control: no-cache\r\n"
            + f"X-Frame-Id: {frame.frame_id}\r\n".encode("ascii")
            + f"X-Frame-Timestamp: {frame.timestamp}\r\n".encode("ascii")
            + b"\r\n"
            + jpeg
            + b"\r\n"
        )
        await asyncio.sleep(max(0.0, delay - (time.monotonic() - started_at)))


def _task_status(task: asyncio.Task[Any]) -> dict[str, Any]:
    status: dict[str, Any] = {
        "name": task.get_name(),
        "done": task.done(),
        "cancelled": task.cancelled(),
    }
    if task.done() and not task.cancelled():
        exc = task.exception()
        if exc is not None:
            status["error"] = repr(exc)
    return status


def _log_background_task_result(task: asyncio.Task[Any]) -> None:
    if task.cancelled():
        return
    exc = task.exception()
    if exc is not None:
        logger.exception("background task %s stopped", task.get_name(), exc_info=exc)


def _decode_browser_frame(image: str) -> np.ndarray:
    payload = image.split(",", 1)[1] if image.startswith("data:") and "," in image else image
    try:
        raw = base64.b64decode(payload, validate=True)
    except binascii.Error as exc:
        raise ValueError("invalid browser frame image") from exc
    decoded = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if decoded is None:
        raise ValueError("browser frame image could not be decoded")
    return decoded


def _request_resolution(width: int | None, height: int | None) -> tuple[int, int] | None:
    if width is None and height is None:
        return None
    if width is None or height is None:
        raise HTTPException(status_code=400, detail="width and height must be provided together")
    return width, height


def _runtime(app: FastAPI) -> Runtime:
    return app.state.runtime


def _build_runtime(settings: Settings) -> Runtime:
    frame_buffer = FrameBuffer(max_size=30)
    preview_frame_buffer = FrameBuffer(max_size=5)
    preview_executor = concurrent.futures.ThreadPoolExecutor(
        max_workers=1,
        thread_name_prefix="mjpeg-preview",
    )
    object_state = InterestObjectState()
    scene_store = JsonlStore(settings.storage_dir / "scenes.jsonl")
    prediction_store = JsonlStore(settings.storage_dir / "predictions.jsonl")
    first_person_analysis_store = JsonlStore(settings.storage_dir / "first_person_analyses.jsonl")
    llm = build_llm_client(settings)
    scene_worker = GlobalSceneWorker(
        settings=settings,
        llm=llm,
        object_state=object_state,
        store=scene_store,
    )
    interaction_worker = InteractionWorker(
        llm=llm,
        object_state=object_state,
        scene_store=scene_store,
        prediction_store=prediction_store,
        first_person_analysis_store=first_person_analysis_store,
        interval_sec=settings.interaction_interval_sec,
        stable_duration_sec=settings.interest_stable_duration_sec,
        stable_match_ratio=settings.interest_stable_match_ratio,
        stable_min_samples=settings.interest_stable_min_samples,
        timeout_sec=settings.llm_timeout_sec,
    )
    yolo_worker = _build_yolo_worker(settings, object_state)
    return Runtime(
        settings=settings,
        frame_buffer=frame_buffer,
        preview_frame_buffer=preview_frame_buffer,
        camera_reader=CameraReader(
            source=settings.camera_url,
            fps_limit=settings.camera_fps_limit,
            reconnect_sec=settings.camera_reconnect_sec,
            resolution=settings.camera_resolution,
            analysis_fps_limit=settings.analysis_fps_limit,
            analysis_max_side=settings.analysis_max_side,
        ),
        object_state=object_state,
        yolo_worker=yolo_worker,
        scene_worker=scene_worker,
        interaction_worker=interaction_worker,
        scene_store=scene_store,
        prediction_store=prediction_store,
        first_person_analysis_store=first_person_analysis_store,
        llm=llm,
        preview_executor=preview_executor,
        tasks=[],
    )


def _build_yolo_worker(settings: Settings, object_state: InterestObjectState) -> YoloWorker:
    return YoloWorker(
        model_name=settings.yolo_model,
        confidence=settings.yolo_confidence,
        image_size=settings.yolo_image_size,
        fps=settings.yolo_fps,
        device=settings.yolo_device,
        min_interest_score=settings.min_interest_score,
        state=object_state,
    )


async def _reset_observation_state(runtime: Runtime) -> None:
    runtime.observation_generation += 1
    await runtime.frame_buffer.clear()
    await runtime.preview_frame_buffer.clear()
    await runtime.object_state.reset()
    runtime.yolo_worker.reset()
    runtime.scene_worker.reset()
    runtime.interaction_worker.reset()
    runtime.scene_store.clear()
    runtime.prediction_store.clear()
    runtime.first_person_analysis_store.clear()

from __future__ import annotations

import asyncio
import base64
import binascii
import logging
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, HTTPException, Query, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .camera import CameraReader, FrameBuffer, detect_camera_sources
from .config import Settings
from .interaction_worker import InteractionWorker
from .llm import JsonLlmClient, build_llm_client
from .scene_worker import GlobalSceneWorker
from .storage import JsonlStore
from .utils import frame_to_jpeg_bytes
from .yolo_worker import InterestObjectState, YoloWorker

logger = logging.getLogger(__name__)


class CameraSourceRequest(BaseModel):
    source: str


class BrowserFrameRequest(BaseModel):
    source: str
    image: str


@dataclass(slots=True)
class Runtime:
    settings: Settings
    frame_buffer: FrameBuffer
    camera_reader: CameraReader
    object_state: InterestObjectState
    yolo_worker: YoloWorker
    scene_worker: GlobalSceneWorker
    interaction_worker: InteractionWorker
    scene_store: JsonlStore
    prediction_store: JsonlStore
    llm: JsonLlmClient
    tasks: list[asyncio.Task[Any]]


def create_app(settings: Settings | None = None) -> FastAPI:
    settings = settings or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        runtime = _build_runtime(settings)
        app.state.runtime = runtime
        runtime.tasks = [
            asyncio.create_task(runtime.camera_reader.run(runtime.frame_buffer), name="camera"),
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
        frame = await runtime.frame_buffer.latest()
        return {
            "ok": True,
            "camera": runtime.camera_reader.status,
            "latest_frame": (
                {
                    "frame_id": frame.frame_id,
                    "timestamp": frame.timestamp,
                    "source": frame.source,
                }
                if frame
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

    @app.get("/history/scenes")
    async def scene_history(limit: int = Query(20, ge=1, le=200)) -> list[dict[str, Any]]:
        return _runtime(app).scene_store.read_tail(limit)

    @app.get("/history/predictions")
    async def prediction_history(limit: int = Query(20, ge=1, le=200)) -> list[dict[str, Any]]:
        return _runtime(app).prediction_store.read_tail(limit)

    @app.get("/camera/source")
    async def camera_source() -> dict[str, Any]:
        runtime = _runtime(app)
        return {
            "source": await runtime.camera_reader.get_source(),
            "status": runtime.camera_reader.status,
        }

    @app.post("/camera/source")
    async def set_camera_source(request: CameraSourceRequest) -> dict[str, Any]:
        runtime = _runtime(app)
        source = request.source.strip()
        result = await runtime.camera_reader.set_source(source)
        if result.get("changed"):
            await _reset_observation_state(runtime)
        return {"ok": True, **result}

    @app.post("/camera/browser-frame")
    async def ingest_browser_frame(request: BrowserFrameRequest) -> dict[str, Any]:
        runtime = _runtime(app)
        try:
            image = _decode_browser_frame(request.image)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        accepted = await runtime.camera_reader.ingest_browser_frame(
            source=request.source.strip(),
            image=image,
            frame_buffer=runtime.frame_buffer,
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
            "sources": [asdict(item) for item in sources],
        }

    @app.get("/snapshot")
    async def snapshot() -> Response:
        frame = await _runtime(app).frame_buffer.latest()
        if frame is None:
            return Response(status_code=404, content=b"no frame available")
        return Response(content=frame_to_jpeg_bytes(frame.image), media_type="image/jpeg")

    return app


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


def _runtime(app: FastAPI) -> Runtime:
    return app.state.runtime


def _build_runtime(settings: Settings) -> Runtime:
    frame_buffer = FrameBuffer(max_size=30)
    object_state = InterestObjectState()
    scene_store = JsonlStore(settings.storage_dir / "scenes.jsonl")
    prediction_store = JsonlStore(settings.storage_dir / "predictions.jsonl")
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
        camera_reader=CameraReader(
            source=settings.camera_url,
            fps_limit=settings.camera_fps_limit,
            reconnect_sec=settings.camera_reconnect_sec,
        ),
        object_state=object_state,
        yolo_worker=yolo_worker,
        scene_worker=scene_worker,
        interaction_worker=interaction_worker,
        scene_store=scene_store,
        prediction_store=prediction_store,
        llm=llm,
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
    await runtime.frame_buffer.clear()
    await runtime.object_state.reset()
    runtime.yolo_worker.reset()
    runtime.scene_worker.reset()
    runtime.interaction_worker.reset()
    runtime.scene_store.clear()
    runtime.prediction_store.clear()

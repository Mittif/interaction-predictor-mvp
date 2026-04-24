from __future__ import annotations

import asyncio
import logging
from typing import Any

from .camera import FrameBuffer
from .config import Settings
from .models import SceneEntity, SceneGuess, SceneObservation
from .llm import JsonLlmClient
from .prompts import GLOBAL_IMAGE_PROMPT, scene_prompt_from_detections
from .storage import JsonlStore
from .utils import compact_timestamp, frame_to_jpeg_base64
from .yolo_worker import InterestObjectState

logger = logging.getLogger(__name__)


def _as_confidence(value: Any, default: float = 0.0) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return default


def _normalize_scene(
    *,
    raw: dict[str, Any],
    timestamp: str,
    source: str,
    mode: str,
) -> SceneObservation:
    guess = raw.get("scene_guess")
    if not isinstance(guess, dict):
        guess = {}

    entities = raw.get("main_entities")
    normalized_entities: list[SceneEntity] = []
    if isinstance(entities, list):
        for item in entities[:20]:
            if not isinstance(item, dict):
                continue
            name = str(item.get("name") or item.get("label") or "unknown")
            normalized_entities.append(
                SceneEntity(
                    name=name,
                    category=item.get("category"),
                    location=item.get("location"),
                    confidence=(
                        _as_confidence(item.get("confidence"), 0.0)
                        if item.get("confidence") is not None
                        else None
                    ),
                )
            )

    return SceneObservation(
        id=f"scene_{compact_timestamp()}",
        timestamp=timestamp,
        source=source,
        mode=mode,
        scene_guess=SceneGuess(
            type=str(guess.get("type") or "unknown"),
            confidence=_as_confidence(guess.get("confidence"), 0.0),
            description=str(guess.get("description") or "无法可靠判断当前场景"),
        ),
        main_entities=normalized_entities,
        lighting=raw.get("lighting") if isinstance(raw.get("lighting"), str) else None,
        activity_hint=(
            raw.get("activity_hint") if isinstance(raw.get("activity_hint"), str) else None
        ),
        uncertainty=raw.get("uncertainty") if isinstance(raw.get("uncertainty"), str) else None,
        raw_llm_output=raw,
    )


class GlobalSceneWorker:
    def __init__(
        self,
        *,
        settings: Settings,
        llm: JsonLlmClient,
        object_state: InterestObjectState,
        store: JsonlStore,
    ) -> None:
        self.settings = settings
        self.llm = llm
        self.object_state = object_state
        self.store = store
        self.health: dict[str, Any] = {"ready": False, "error": None}
        self._generation = 0
        self._reset_event = asyncio.Event()

    async def run(self, frame_buffer: FrameBuffer) -> None:
        while True:
            frame = await frame_buffer.latest()
            if frame is None:
                await asyncio.sleep(0.2)
                continue

            generation = self._generation
            try:
                mode = self.settings.scene_input_mode
                if mode == "image":
                    image = frame_to_jpeg_base64(
                        frame.image,
                        max_side=self.settings.scene_image_max_side,
                        quality=self.settings.scene_image_jpeg_quality,
                    )
                    self.health = {
                        "ready": False,
                        "status": "analyzing_scene",
                        "mode": mode,
                        "provider": self.settings.llm_provider,
                        "model": self.settings.active_vision_model,
                        "source": frame.source or self.settings.camera_url,
                        "error": None,
                    }
                    raw = await self._generate_json_with_reset(
                        prompt=GLOBAL_IMAGE_PROMPT,
                        generation=generation,
                        reset_event=self._reset_event,
                        model=self.settings.active_vision_model,
                        images=[image],
                        max_tokens=900,
                    )
                elif mode == "detections":
                    detections = await self.object_state.latest_detections()
                    self.health = {
                        "ready": False,
                        "status": "analyzing_scene",
                        "mode": mode,
                        "provider": self.settings.llm_provider,
                        "model": self.settings.active_model,
                        "source": frame.source or self.settings.camera_url,
                        "error": None,
                    }
                    raw = await self._generate_json_with_reset(
                        prompt=scene_prompt_from_detections(detections),
                        generation=generation,
                        reset_event=self._reset_event,
                        max_tokens=900,
                    )
                else:
                    raise ValueError(
                        f"unsupported SCENE_INPUT_MODE={mode!r}; use image or detections"
                    )

                if raw is None:
                    continue
                if generation != self._generation:
                    continue
                scene = _normalize_scene(
                    raw=raw,
                    timestamp=frame.timestamp,
                    source=frame.source or self.settings.camera_url,
                    mode=mode,
                )
                self.store.append(scene.model_dump(mode="json"))
                self.health = {
                    "ready": True,
                    "mode": mode,
                    "provider": self.settings.llm_provider,
                    "model": self.settings.active_model,
                    "latest_scene_id": scene.id,
                    "error": None,
                }
            except Exception as exc:  # noqa: BLE001
                if generation != self._generation:
                    continue
                logger.exception("global scene worker failed")
                fallback = SceneObservation(
                    id=f"scene_{compact_timestamp()}",
                    timestamp=frame.timestamp,
                    source=frame.source or self.settings.camera_url,
                    mode=self.settings.scene_input_mode,
                    scene_guess=SceneGuess(
                        type="unknown",
                        confidence=0.0,
                        description="场景理解失败",
                    ),
                    uncertainty=str(exc),
                    raw_llm_output={"error": str(exc)},
                )
                self.store.append(fallback.model_dump(mode="json"))
                self.health = {"ready": False, "error": str(exc)}

            await asyncio.sleep(self.settings.scene_interval_sec)

    def reset(self) -> None:
        self._generation += 1
        self._reset_event.set()
        self._reset_event = asyncio.Event()
        self.health = {"ready": False, "error": None}

    async def _generate_json_with_reset(
        self,
        *,
        prompt: str,
        generation: int,
        reset_event: asyncio.Event,
        model: str | None = None,
        images: list[str] | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any] | None:
        request_task = asyncio.create_task(
            asyncio.wait_for(
                self.llm.generate_json(
                    prompt,
                    model=model,
                    images=images,
                    max_tokens=max_tokens,
                ),
                timeout=self.settings.llm_timeout_sec,
            )
        )
        reset_task = asyncio.create_task(reset_event.wait())
        try:
            done, pending = await asyncio.wait(
                {request_task, reset_task},
                return_when=asyncio.FIRST_COMPLETED,
            )
        except BaseException:
            request_task.cancel()
            reset_task.cancel()
            await asyncio.gather(request_task, reset_task, return_exceptions=True)
            raise
        for task in pending:
            task.cancel()
        await asyncio.gather(*pending, return_exceptions=True)
        if reset_task in done and generation != self._generation:
            request_task.cancel()
            await asyncio.gather(request_task, return_exceptions=True)
            return None
        return await request_task

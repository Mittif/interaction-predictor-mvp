from __future__ import annotations

import asyncio
import logging
from typing import Any

from .models import InteractionPrediction, PossibleInteraction
from .llm import JsonLlmClient
from .prompts import interaction_prompt
from .storage import JsonlStore
from .utils import compact_timestamp, utc_timestamp
from .yolo_worker import InterestObjectState

logger = logging.getLogger(__name__)

FIRST_PERSON_INTERACTION_QUESTION = (
    "如果我在这样一个<环境>中，我的视野关注点在一个<object>上，"
    "我可能对这个<object>产生的潜在交互行为是什么？"
)


def _confidence(value: Any, default: float = 0.0) -> float:
    try:
        return max(0.0, min(1.0, float(value)))
    except (TypeError, ValueError):
        return default


def _scene_object_names(scene: dict[str, Any]) -> list[str]:
    entities = scene.get("main_entities")
    if not isinstance(entities, list):
        return []
    names: list[str] = []
    for item in entities:
        if isinstance(item, dict) and item.get("name"):
            names.append(str(item["name"]))
    return names


def _scene_summary(scene: dict[str, Any]) -> dict[str, Any]:
    scene_guess = scene.get("scene_guess") if isinstance(scene.get("scene_guess"), dict) else {}
    return {
        "id": scene.get("id"),
        "type": scene_guess.get("type", "unknown"),
        "description": scene_guess.get("description", "未知场景"),
        "confidence": scene_guess.get("confidence", 0.0),
        "activity_hint": scene.get("activity_hint"),
    }


def _interest_summary(interest_object: dict[str, Any]) -> dict[str, Any]:
    return {
        "tracking_id": interest_object.get("tracking_id"),
        "name": interest_object.get("display_name") or interest_object.get("label", "unknown"),
        "category": interest_object.get("label", "unknown"),
        "confidence": interest_object.get("confidence", 0.0),
        "center_score": interest_object.get("center_score", 0.0),
        "interest_score": interest_object.get("interest_score", 0.0),
        "bbox": interest_object.get("bbox"),
    }


def _normalize_prediction(
    *,
    raw: dict[str, Any],
    scene: dict[str, Any],
    interest_object: dict[str, Any],
) -> InteractionPrediction:
    raw_interactions = raw.get("possible_interactions")
    interactions: list[PossibleInteraction] = []
    if isinstance(raw_interactions, list):
        for index, item in enumerate(raw_interactions[:3], start=1):
            if not isinstance(item, dict):
                continue
            interactions.append(
                PossibleInteraction(
                    rank=int(item.get("rank") or index),
                    action=str(item.get("action") or "未知交互"),
                    reason=str(item.get("reason") or "信息不足，无法可靠解释"),
                    confidence=_confidence(item.get("confidence"), 0.0),
                )
            )

    if not interactions:
        interactions = [
            PossibleInteraction(
                rank=1,
                action=f"观察或靠近{interest_object.get('display_name') or interest_object.get('label')}",
                reason="当前只有兴趣物检测信息，缺少足够上下文",
                confidence=0.2,
            )
        ]

    scene_objects = _scene_object_names(scene)
    interest_name = str(interest_object.get("display_name") or interest_object.get("label", "unknown"))
    if interest_name not in scene_objects:
        scene_objects.append(interest_name)

    return InteractionPrediction(
        id=f"prediction_{compact_timestamp()}",
        timestamp=utc_timestamp(),
        scene=_scene_summary(scene),
        scene_objects=[str(item) for item in scene_objects[:30]],
        interest_object=_interest_summary(interest_object),
        possible_interactions=interactions,
        raw_llm_output=raw,
    )


def _build_first_person_analysis_record(
    *,
    prediction: InteractionPrediction,
    scene: dict[str, Any],
    interest_object: dict[str, Any],
    prompt: str,
    raw: dict[str, Any],
    require_stable: bool,
    trigger: str,
    source: str | None = None,
) -> dict[str, Any]:
    prediction_json = prediction.model_dump(mode="json")
    return {
        "id": prediction_json["id"].replace("prediction_", "first_person_analysis_", 1),
        "timestamp": prediction_json["timestamp"],
        "mode": "first_person_interaction",
        "trigger": trigger,
        "question": FIRST_PERSON_INTERACTION_QUESTION,
        "require_stable": require_stable,
        "source": source if source is not None else scene.get("source"),
        "scene": scene,
        "interest_object": interest_object,
        "prompt": prompt,
        "raw_llm_output": raw,
        "prediction": prediction_json,
    }


class InteractionWorker:
    def __init__(
        self,
        *,
        llm: JsonLlmClient,
        object_state: InterestObjectState,
        scene_store: JsonlStore,
        prediction_store: JsonlStore,
        first_person_analysis_store: JsonlStore | None = None,
        interval_sec: float,
        stable_duration_sec: float = 2.0,
        stable_match_ratio: float = 0.75,
        stable_min_samples: int = 4,
        timeout_sec: float = 120.0,
    ) -> None:
        self.llm = llm
        self.object_state = object_state
        self.scene_store = scene_store
        self.prediction_store = prediction_store
        self.first_person_analysis_store = first_person_analysis_store
        self.interval_sec = interval_sec
        self.stable_duration_sec = stable_duration_sec
        self.stable_match_ratio = stable_match_ratio
        self.stable_min_samples = stable_min_samples
        self.timeout_sec = timeout_sec
        self.health: dict[str, Any] = {"ready": False, "error": None}
        self._last_key: str | None = None
        self._generation = 0
        self._reset_event = asyncio.Event()

    async def run(self) -> None:
        while True:
            generation = self._generation
            try:
                scene = self.scene_store.latest()
                interest_object = await self.object_state.latest_stable_interest_object(
                    min_duration_sec=self.stable_duration_sec,
                    min_match_ratio=self.stable_match_ratio,
                    min_samples=self.stable_min_samples,
                )
                if scene is None:
                    self.health = {"ready": False, "waiting": "scene"}
                    await asyncio.sleep(0.2)
                    continue
                if interest_object is None:
                    self.health = {
                        "ready": False,
                        "waiting": "stable_interest_object",
                        "stable_duration_sec": self.stable_duration_sec,
                        "stable_match_ratio": self.stable_match_ratio,
                        "error": None,
                    }
                    await asyncio.sleep(0.2)
                    continue

                key = "|".join(
                    [
                        str(scene.get("id")),
                        str(interest_object.get("tracking_id")),
                        str(interest_object.get("label")),
                    ]
                )
                if key == self._last_key:
                    await asyncio.sleep(0.2)
                    continue

                self.health = {
                    "ready": False,
                    "status": "predicting",
                    "trigger": "stable_interest_object",
                    "scene_id": scene.get("id"),
                    "interest": interest_object.get("display_name")
                    or interest_object.get("label"),
                    "stable_duration_sec": self.stable_duration_sec,
                    "error": None,
                }
                prompt = interaction_prompt(scene, interest_object)
                raw = await self._generate_json_with_reset(
                    prompt=prompt,
                    generation=generation,
                    reset_event=self._reset_event,
                )
                if raw is None:
                    continue
                if generation != self._generation:
                    continue
                prediction = _normalize_prediction(
                    raw=raw,
                    scene=scene,
                    interest_object=interest_object,
                )
                self.prediction_store.append(prediction.model_dump(mode="json"))
                if self.first_person_analysis_store is not None:
                    self.first_person_analysis_store.append(
                        _build_first_person_analysis_record(
                            prediction=prediction,
                            scene=scene,
                            interest_object=interest_object,
                            prompt=prompt,
                            raw=raw,
                            require_stable=True,
                            trigger="stable_interest_object",
                        )
                    )
                self._last_key = key
                self.health = {
                    "ready": True,
                    "latest_prediction_id": prediction.id,
                    "trigger": "stable_interest_object",
                    "stable_duration_sec": self.stable_duration_sec,
                    "error": None,
                }
            except Exception as exc:  # noqa: BLE001
                logger.exception("interaction worker failed")
                self.health = {"ready": False, "error": str(exc)}
                await asyncio.sleep(1.0)

            await asyncio.sleep(self.interval_sec)

    def reset(self) -> None:
        self._last_key = None
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
    ) -> dict[str, Any] | None:
        request_task = asyncio.create_task(
            asyncio.wait_for(
                self.llm.generate_json(prompt, max_tokens=700),
                timeout=self.timeout_sec,
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

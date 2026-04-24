from __future__ import annotations

import asyncio
import logging
import math
import time
from collections import deque
from dataclasses import dataclass
from typing import Any

from .camera import FrameBuffer
from .models import BBox, DetectedObject
from .utils import location_from_bbox

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class _Track:
    track_id: str
    label: str
    bbox: BBox
    first_seen: float
    last_seen: float
    seen_count: int


def _bbox_iou(a: BBox, b: BBox) -> float:
    x1 = max(a.x1, b.x1)
    y1 = max(a.y1, b.y1)
    x2 = min(a.x2, b.x2)
    y2 = min(a.y2, b.y2)
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    union = a.area + b.area - intersection
    if union <= 0:
        return 0.0
    return intersection / union


def _clamp01(value: float) -> float:
    return max(0.0, min(1.0, value))


class InterestObjectState:
    def __init__(self) -> None:
        self._detections: list[DetectedObject] = []
        self._interest_object: DetectedObject | None = None
        self._interest_history: deque[tuple[float, DetectedObject | None]] = deque(maxlen=120)
        self._lock = asyncio.Lock()
        self.health: dict[str, Any] = {"ready": False, "error": None}

    async def update(
        self,
        *,
        detections: list[DetectedObject],
        interest_object: DetectedObject | None,
    ) -> None:
        now = time.monotonic()
        async with self._lock:
            self._detections = detections
            self._interest_object = interest_object
            history_item = interest_object.model_copy(deep=True) if interest_object else None
            self._interest_history.append((now, history_item))
            self._trim_interest_history(now, max_age_sec=5.0)

    async def latest_detections(self) -> list[dict[str, Any]]:
        async with self._lock:
            return [item.model_dump(mode="json") for item in self._detections]

    async def latest_interest_object(self) -> dict[str, Any] | None:
        async with self._lock:
            if self._interest_object is None:
                return None
            return self._interest_object.model_dump(mode="json")

    async def latest_stable_interest_object(
        self,
        *,
        min_duration_sec: float = 2.0,
        min_match_ratio: float = 0.75,
        min_samples: int = 4,
    ) -> dict[str, Any] | None:
        now = time.monotonic()
        async with self._lock:
            current = self._interest_object
            if current is None:
                return None
            samples = [
                item for item in self._interest_history if now - item[0] <= min_duration_sec
            ]
            if len(samples) < min_samples:
                return None
            window_age = samples[-1][0] - samples[0][0]
            if window_age < min_duration_sec * 0.75:
                return None
            matches = 0
            valid = 0
            for _, item in samples:
                if item is None:
                    continue
                valid += 1
                if self._is_same_interest(current, item):
                    matches += 1
            if valid < min_samples:
                return None
            match_ratio = matches / max(1, len(samples))
            if match_ratio < min_match_ratio:
                return None
            payload = current.model_dump(mode="json")
            payload["stability"] = {
                "duration_ms": int(window_age * 1000),
                "sample_count": len(samples),
                "matched_count": matches,
                "match_ratio": match_ratio,
            }
            return payload

    async def reset(self) -> None:
        async with self._lock:
            self._detections = []
            self._interest_object = None
            self._interest_history.clear()
            self.health = {"ready": False, "error": None}

    def _trim_interest_history(self, now: float, *, max_age_sec: float) -> None:
        while self._interest_history and now - self._interest_history[0][0] > max_age_sec:
            self._interest_history.popleft()

    @staticmethod
    def _is_same_interest(current: DetectedObject, candidate: DetectedObject) -> bool:
        if current.tracking_id and candidate.tracking_id == current.tracking_id:
            return True
        if candidate.label != current.label:
            return False
        return _bbox_iou(candidate.bbox, current.bbox) >= 0.35


class YoloWorker:
    def __init__(
        self,
        *,
        model_name: str,
        confidence: float,
        image_size: int,
        fps: float,
        device: str | None,
        min_interest_score: float,
        state: InterestObjectState,
    ) -> None:
        self.model_name = model_name
        self.confidence = confidence
        self.image_size = image_size
        self.fps = fps
        self.device = device
        self.min_interest_score = min_interest_score
        self.state = state
        self._model: Any = None
        self._tracks: dict[str, _Track] = {}
        self._next_track_id = 1
        self._generation = 0

    def reset(self) -> None:
        self._generation += 1
        self._tracks.clear()
        self._next_track_id = 1
        self.state.health = {
            "ready": self._model is not None,
            "model": self.model_name,
            "detections": 0,
            "interest": None,
            "interest_observed_ms": 0,
            "interest_location": None,
            "error": None,
        }

    def _load_model(self) -> None:
        if self._model is not None:
            return
        from ultralytics import YOLO

        logger.info("loading YOLO model: %s", self.model_name)
        self._model = YOLO(self.model_name)
        self.state.health = {"ready": True, "model": self.model_name, "error": None}

    def _detect(self, frame_image: Any, timestamp: str) -> list[DetectedObject]:
        self._load_model()
        height, width = frame_image.shape[:2]
        kwargs: dict[str, Any] = {
            "imgsz": self.image_size,
            "conf": self.confidence,
            "verbose": False,
        }
        if self.device:
            kwargs["device"] = self.device

        results = self._model(frame_image, **kwargs)
        if not results:
            return []
        result = results[0]
        boxes = getattr(result, "boxes", None)
        if boxes is None:
            return []

        names = getattr(result, "names", {}) or {}
        now = time.time()
        raw: list[tuple[str, float, BBox]] = []
        for box in boxes:
            xyxy = box.xyxy[0].tolist()
            cls_id = int(box.cls[0])
            if isinstance(names, dict):
                label = str(names.get(cls_id, cls_id))
            else:
                label = str(names[cls_id])
            raw.append(
                (
                    label,
                    float(box.conf[0]),
                    BBox(x1=float(xyxy[0]), y1=float(xyxy[1]), x2=float(xyxy[2]), y2=float(xyxy[3])),
                )
            )

        self._expire_tracks(now)
        detections: list[DetectedObject] = []
        used_tracks: set[str] = set()
        for label, confidence, bbox in raw:
            track = self._assign_track(label, bbox, now, used_tracks)
            used_tracks.add(track.track_id)
            area_ratio = bbox.area / max(1.0, float(width * height))
            center_score = self._center_score(bbox, width, height)
            size_weight = self._size_weight(area_ratio)
            stability_weight = _clamp01(track.seen_count / 5.0)
            interest_score = confidence * (
                0.62 * center_score + 0.23 * size_weight + 0.15 * stability_weight
            )
            detections.append(
                DetectedObject(
                    timestamp=timestamp,
                    label=label,
                    display_name=label,
                    confidence=confidence,
                    bbox=bbox,
                    center_score=center_score,
                    interest_score=interest_score,
                    area_ratio=area_ratio,
                    tracking_id=track.track_id,
                    observed_duration_ms=int((now - track.first_seen) * 1000),
                )
            )

        detections.sort(key=lambda item: item.interest_score, reverse=True)
        if detections and detections[0].interest_score >= self.min_interest_score:
            detections[0].is_interest_object = True
        return detections

    def _assign_track(
        self,
        label: str,
        bbox: BBox,
        now: float,
        used_tracks: set[str],
    ) -> _Track:
        best: _Track | None = None
        best_iou = 0.0
        for track in self._tracks.values():
            if track.track_id in used_tracks or track.label != label:
                continue
            iou = _bbox_iou(track.bbox, bbox)
            if iou > best_iou:
                best = track
                best_iou = iou

        if best is not None and best_iou >= 0.25:
            best.bbox = bbox
            best.last_seen = now
            best.seen_count += 1
            return best

        track_id = f"track_{self._next_track_id}"
        self._next_track_id += 1
        track = _Track(
            track_id=track_id,
            label=label,
            bbox=bbox,
            first_seen=now,
            last_seen=now,
            seen_count=1,
        )
        self._tracks[track_id] = track
        return track

    def _expire_tracks(self, now: float) -> None:
        expired = [
            track_id for track_id, track in self._tracks.items() if now - track.last_seen > 3.0
        ]
        for track_id in expired:
            self._tracks.pop(track_id, None)

    @staticmethod
    def _center_score(bbox: BBox, width: int, height: int) -> float:
        cx = (bbox.x1 + bbox.x2) / 2.0
        cy = (bbox.y1 + bbox.y2) / 2.0
        distance = math.sqrt((cx - width / 2) ** 2 + (cy - height / 2) ** 2)
        max_distance = math.sqrt((width / 2) ** 2 + (height / 2) ** 2)
        return _clamp01(1.0 - distance / max(1.0, max_distance))

    @staticmethod
    def _size_weight(area_ratio: float) -> float:
        if area_ratio < 0.02:
            return _clamp01(area_ratio / 0.02)
        if area_ratio > 0.45:
            return _clamp01(1.0 - (area_ratio - 0.45) / 0.55)
        return 1.0

    async def run(self, frame_buffer: FrameBuffer) -> None:
        min_delay = 1.0 / self.fps if self.fps > 0 else 0.0
        last_frame_id = -1
        while True:
            frame = await frame_buffer.latest()
            if frame is None or frame.frame_id == last_frame_id:
                await asyncio.sleep(0.05)
                continue
            last_frame_id = frame.frame_id
            generation = self._generation
            try:
                detections = await asyncio.to_thread(self._detect, frame.image, frame.timestamp)
                if generation != self._generation:
                    continue
                interest = detections[0] if detections and detections[0].is_interest_object else None
                await self.state.update(detections=detections, interest_object=interest)
                if detections:
                    height, width = frame.image.shape[:2]
                    self.state.health = {
                        "ready": True,
                        "model": self.model_name,
                        "detections": len(detections),
                        "interest": interest.label if interest else None,
                        "interest_observed_ms": (
                            interest.observed_duration_ms if interest else None
                        ),
                        "interest_location": (
                            location_from_bbox(
                                interest.bbox.x1,
                                interest.bbox.y1,
                                interest.bbox.x2,
                                interest.bbox.y2,
                                width,
                                height,
                            )
                            if interest
                            else None
                        ),
                        "error": None,
                    }
            except Exception as exc:  # noqa: BLE001
                logger.exception("YOLO worker failed")
                self.state.health = {"ready": False, "model": self.model_name, "error": str(exc)}
                await asyncio.sleep(2.0)
            if min_delay:
                await asyncio.sleep(min_delay)

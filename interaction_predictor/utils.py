from __future__ import annotations

import base64
import json
from datetime import datetime, timezone
from typing import Any

import cv2
import numpy as np


def utc_timestamp() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="milliseconds")


def compact_timestamp() -> str:
    return datetime.now(timezone.utc).astimezone().strftime("%Y%m%d_%H%M%S_%f")


def frame_to_jpeg_base64(frame: np.ndarray, *, max_side: int, quality: int) -> str:
    height, width = frame.shape[:2]
    scale = min(1.0, max_side / max(height, width))
    if scale < 1.0:
        frame = cv2.resize(frame, (int(width * scale), int(height * scale)))
    ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("failed to encode frame as jpeg")
    return base64.b64encode(encoded.tobytes()).decode("ascii")


def frame_to_jpeg_bytes(frame: np.ndarray, *, quality: int = 85) -> bytes:
    ok, encoded = cv2.imencode(".jpg", frame, [int(cv2.IMWRITE_JPEG_QUALITY), quality])
    if not ok:
        raise RuntimeError("failed to encode frame as jpeg")
    return encoded.tobytes()


def parse_json_object(text: str) -> dict[str, Any]:
    text = text.strip()
    try:
        value = json.loads(text)
        if isinstance(value, dict):
            return value
        return {"value": value}
    except json.JSONDecodeError:
        pass

    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise ValueError(f"model response does not contain a JSON object: {text[:200]}")

    value = json.loads(text[start : end + 1])
    if not isinstance(value, dict):
        return {"value": value}
    return value


def location_from_bbox(x1: float, y1: float, x2: float, y2: float, width: int, height: int) -> str:
    cx = (x1 + x2) / 2.0
    cy = (y1 + y2) / 2.0
    horizontal = "left" if cx < width / 3 else "right" if cx > width * 2 / 3 else "center"
    vertical = "upper" if cy < height / 3 else "lower" if cy > height * 2 / 3 else "middle"
    if horizontal == "center" and vertical == "middle":
        return "center"
    return f"{vertical}-{horizontal}"


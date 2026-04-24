from __future__ import annotations

import asyncio
import json
import logging
import os
import platform
import re
import shutil
import subprocess
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any

os.environ.setdefault("OPENCV_AVFOUNDATION_SKIP_AUTH", "0")

import cv2
import numpy as np

from .utils import utc_timestamp

logger = logging.getLogger(__name__)


@dataclass(slots=True)
class Frame:
    frame_id: int
    timestamp: str
    image: np.ndarray
    source: str | None = None


@dataclass(slots=True)
class CameraSource:
    id: str
    source: str
    label: str
    type: str
    available: bool
    details: dict[str, Any]


class FrameBuffer:
    def __init__(self, max_size: int = 30) -> None:
        self._frames: deque[Frame] = deque(maxlen=max_size)
        self._latest: Frame | None = None
        self._lock = asyncio.Lock()

    async def put(self, frame: Frame) -> None:
        async with self._lock:
            self._frames.append(frame)
            self._latest = frame

    async def latest(self) -> Frame | None:
        async with self._lock:
            return self._latest

    async def history(self) -> list[Frame]:
        async with self._lock:
            return list(self._frames)

    async def clear(self) -> None:
        async with self._lock:
            self._frames.clear()
            self._latest = None


def _parse_camera_source(source: str) -> int | str:
    if source.isdigit():
        return int(source)
    return source


def _is_avfoundation_source(source: str) -> bool:
    return source.startswith("avfoundation:")


def is_browser_source(source: str) -> bool:
    return source.startswith("browser:")


def _parse_avfoundation_source(source: str) -> int | None:
    if not _is_avfoundation_source(source):
        return None
    value = source.split(":", 1)[1]
    if not value.isdigit():
        return None
    return int(value)


def _source_label(source: str) -> str:
    if is_browser_source(source):
        return "浏览器摄像头"
    if _is_avfoundation_source(source):
        return f"AVFoundation 摄像头 {source.split(':', 1)[1]}"
    if source.isdigit():
        return f"本机摄像头 {source}"
    if source.startswith(("http://", "https://", "rtsp://", "rtmp://")):
        return source
    return Path(source).name or source


def _macos_camera_names() -> list[str]:
    if platform.system() != "Darwin":
        return []
    try:
        completed = subprocess.run(
            ["system_profiler", "SPCameraDataType", "-json"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []
    if completed.returncode != 0 or not completed.stdout.strip():
        return []
    try:
        data = json.loads(completed.stdout)
    except json.JSONDecodeError:
        return []
    names: list[str] = []
    for item in data.get("SPCameraDataType", []):
        if isinstance(item, dict):
            name = item.get("_name") or item.get("spcamera_model-id")
            if name:
                names.append(str(name))
    return names


def _ffmpeg_avfoundation_devices() -> list[tuple[int, str]]:
    if platform.system() != "Darwin" or shutil.which("ffmpeg") is None:
        return []
    try:
        completed = subprocess.run(
            ["ffmpeg", "-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""],
            check=False,
            capture_output=True,
            text=True,
            timeout=8,
        )
    except (OSError, subprocess.TimeoutExpired):
        return []

    devices: list[tuple[int, str]] = []
    in_video_section = False
    for line in completed.stderr.splitlines():
        if "AVFoundation video devices:" in line:
            in_video_section = True
            continue
        if "AVFoundation audio devices:" in line:
            break
        if not in_video_section:
            continue
        match = re.search(r"\[(\d+)\]\s+(.+)$", line)
        if not match:
            continue
        index = int(match.group(1))
        name = match.group(2).strip()
        if name.lower().startswith("capture screen"):
            continue
        devices.append((index, name))
    return devices


def detect_camera_sources(
    *,
    max_index: int,
    demo_video_path: Path | None,
    current_source: str | None = None,
) -> list[CameraSource]:
    sources: list[CameraSource] = []
    avfoundation_devices = _ffmpeg_avfoundation_devices()
    if avfoundation_devices:
        for index, name in avfoundation_devices:
            sources.append(
                CameraSource(
                    id=f"avfoundation:{index}",
                    source=f"avfoundation:{index}",
                    label=f"{name} ({index})",
                    type="camera",
                    available=True,
                    details={
                        "index": index,
                        "backend": "ffmpeg-avfoundation",
                        "system_name": name,
                        "readable": None,
                    },
                )
            )
    macos_names = [] if avfoundation_devices else _macos_camera_names()
    probe_count = 0 if avfoundation_devices else max(max(0, max_index), len(macos_names))
    for index in range(probe_count):
        cap = cv2.VideoCapture(index)
        try:
            opened = cap.isOpened()
            ok = False
            frame = None
            if opened:
                ok, frame = cap.read()
            has_system_device = index < len(macos_names)
            if not opened and not has_system_device:
                continue
            label = macos_names[index] if has_system_device else f"本机摄像头 {index}"
            details: dict[str, Any] = {
                "index": index,
                "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
                "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
                "fps": float(cap.get(cv2.CAP_PROP_FPS) or 0.0),
                "opened": opened,
                "readable": bool(ok and frame is not None),
            }
            if has_system_device:
                details["system_name"] = label
            sources.append(
                CameraSource(
                    id=f"camera:{index}",
                    source=str(index),
                    label=f"{label} ({index})" if has_system_device else label,
                    type="camera",
                    available=opened,
                    details=details,
                )
            )
        finally:
            cap.release()

    if demo_video_path is not None:
        demo_path = demo_video_path.expanduser()
        available = demo_path.exists()
        sources.append(
            CameraSource(
                id="demo",
                source=str(demo_path),
                label=f"测试视频 {demo_path.name}",
                type="video",
                available=available,
                details={"path": str(demo_path), "exists": available},
            )
        )

    if current_source and not any(item.source == current_source for item in sources):
        sources.insert(
            0,
            CameraSource(
                id="current",
                source=current_source,
                label=f"当前输入 {_source_label(current_source)}",
                type="custom",
                available=True,
                details={"source": current_source},
            ),
        )

    return sources


class CameraReader:
    def __init__(
        self,
        *,
        source: str,
        fps_limit: float,
        reconnect_sec: float,
    ) -> None:
        self._source = source
        self.fps_limit = fps_limit
        self.reconnect_sec = reconnect_sec
        self.status: dict[str, str | int | float | bool] = {
            "connected": False,
            "source": source,
        }
        self._frame_id = 0
        self._source_lock = asyncio.Lock()
        self._switch_event = asyncio.Event()

    async def get_source(self) -> str:
        async with self._source_lock:
            return self._source

    async def set_source(self, source: str) -> dict[str, str | bool]:
        async with self._source_lock:
            changed = source != self._source
            if not changed:
                return {"source": source, "changed": False}
            self._source = source
            self.status = {
                "connected": False,
                "source": source,
                "switching": True,
            }
            self._switch_event.set()
            return {"source": source, "changed": True}

    async def run(self, frame_buffer: FrameBuffer) -> None:
        min_delay = 1.0 / self.fps_limit if self.fps_limit > 0 else 0.0
        while True:
            source = await self.get_source()
            self._switch_event.clear()
            await frame_buffer.clear()
            if is_browser_source(source):
                self.status = {
                    "connected": False,
                    "source": source,
                    "backend": "browser-get-user-media",
                    "waiting_for_frame_upload": True,
                }
                while not self._switch_event.is_set() and await self.get_source() == source:
                    await asyncio.sleep(self.reconnect_sec)
                continue

            if _is_avfoundation_source(source):
                await self._run_avfoundation_source(source, frame_buffer, min_delay)
                continue

            cap = cv2.VideoCapture(_parse_camera_source(source))
            if not cap.isOpened():
                self.status = {
                    "connected": False,
                    "source": source,
                    "error": "failed to open camera stream",
                }
                logger.warning("failed to open camera stream: %s", source)
                await asyncio.sleep(self.reconnect_sec)
                continue

            self.status = {"connected": True, "source": source}
            try:
                while True:
                    if self._switch_event.is_set() or await self.get_source() != source:
                        logger.info("switching camera source from %s", source)
                        break
                    ok, image = await asyncio.to_thread(cap.read)
                    if not ok or image is None:
                        self.status = {
                            "connected": False,
                            "source": source,
                            "error": "camera stream read failed",
                        }
                        logger.warning("camera stream read failed, reconnecting")
                        break
                    self._frame_id += 1
                    await frame_buffer.put(
                        Frame(
                            frame_id=self._frame_id,
                            timestamp=utc_timestamp(),
                            image=image,
                            source=source,
                        )
                    )
                    if min_delay:
                        await asyncio.sleep(min_delay)
            finally:
                cap.release()
            if self._switch_event.is_set() or await self.get_source() != source:
                continue
            await asyncio.sleep(self.reconnect_sec)

    async def _run_avfoundation_source(
        self,
        source: str,
        frame_buffer: FrameBuffer,
        min_delay: float,
    ) -> None:
        index = _parse_avfoundation_source(source)
        if index is None:
            self.status = {
                "connected": False,
                "source": source,
                "error": "invalid avfoundation source",
            }
            await asyncio.sleep(self.reconnect_sec)
            return
        if shutil.which("ffmpeg") is None:
            self.status = {
                "connected": False,
                "source": source,
                "error": "ffmpeg is required for avfoundation camera sources",
            }
            await asyncio.sleep(self.reconnect_sec)
            return

        stream = _FfmpegAvfoundationStream(index=index, fps=30.0)
        try:
            await stream.start()
            self.status = {"connected": False, "source": source, "backend": "ffmpeg-avfoundation"}
            while True:
                if self._switch_event.is_set() or await self.get_source() != source:
                    logger.info("switching camera source from %s", source)
                    break
                image = await stream.read_frame(timeout_sec=max(5.0, self.reconnect_sec))
                if image is None:
                    self.status = {
                        "connected": False,
                        "source": source,
                        "backend": "ffmpeg-avfoundation",
                        "error": await stream.error_summary(),
                    }
                    logger.warning("avfoundation stream read failed: %s", self.status["error"])
                    break
                self.status = {"connected": True, "source": source, "backend": "ffmpeg-avfoundation"}
                self._frame_id += 1
                await frame_buffer.put(
                    Frame(
                        frame_id=self._frame_id,
                        timestamp=utc_timestamp(),
                        image=image,
                        source=source,
                    )
                )
                if min_delay:
                    await asyncio.sleep(min_delay)
        finally:
            await stream.close()
        if not self._switch_event.is_set() and await self.get_source() == source:
            await asyncio.sleep(self.reconnect_sec)

    async def ingest_browser_frame(
        self,
        *,
        source: str,
        image: np.ndarray,
        frame_buffer: FrameBuffer,
    ) -> bool:
        if not is_browser_source(source) or await self.get_source() != source:
            return False
        self._frame_id += 1
        await frame_buffer.put(
            Frame(frame_id=self._frame_id, timestamp=utc_timestamp(), image=image, source=source)
        )
        self.status = {
            "connected": True,
            "source": source,
            "backend": "browser-get-user-media",
            "frame_id": self._frame_id,
        }
        return True


class _FfmpegAvfoundationStream:
    def __init__(self, *, index: int, fps: float) -> None:
        self.index = index
        self.fps = fps
        self.process: asyncio.subprocess.Process | None = None
        self._buffer = bytearray()
        self._stderr = bytearray()
        self._stderr_task: asyncio.Task[None] | None = None

    async def start(self) -> None:
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-nostdin",
            "-f",
            "avfoundation",
            "-framerate",
            str(int(self.fps)),
            "-i",
            f"{self.index}:none",
            "-an",
            "-q:v",
            "5",
            "-f",
            "image2pipe",
            "-vcodec",
            "mjpeg",
            "pipe:1",
        ]
        self.process = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        self._stderr_task = asyncio.create_task(self._collect_stderr())

    async def read_frame(self, *, timeout_sec: float) -> np.ndarray | None:
        if self.process is None or self.process.stdout is None:
            return None
        try:
            return await asyncio.wait_for(self._read_frame(), timeout=timeout_sec)
        except TimeoutError:
            return None

    async def _read_frame(self) -> np.ndarray | None:
        if self.process is None or self.process.stdout is None:
            return None
        while True:
            start = self._buffer.find(b"\xff\xd8")
            end = self._buffer.find(b"\xff\xd9", start + 2 if start >= 0 else 0)
            if start >= 0 and end >= 0:
                frame_bytes = bytes(self._buffer[start : end + 2])
                del self._buffer[: end + 2]
                image = cv2.imdecode(np.frombuffer(frame_bytes, dtype=np.uint8), cv2.IMREAD_COLOR)
                if image is not None:
                    return image
            chunk = await self.process.stdout.read(64 * 1024)
            if not chunk:
                return None
            self._buffer.extend(chunk)

    async def _collect_stderr(self) -> None:
        if self.process is None or self.process.stderr is None:
            return
        while True:
            chunk = await self.process.stderr.read(4096)
            if not chunk:
                return
            self._stderr.extend(chunk)
            if len(self._stderr) > 8192:
                del self._stderr[: len(self._stderr) - 8192]

    async def error_summary(self) -> str:
        stderr = self._stderr.decode(errors="replace").strip()
        if self.process is not None and self.process.returncode is not None:
            return stderr or f"ffmpeg exited with code {self.process.returncode}"
        if stderr:
            return f"ffmpeg avfoundation source did not produce frames before timeout. stderr: {stderr}"
        return "ffmpeg avfoundation source did not produce frames before timeout"

    async def close(self) -> None:
        if self.process is not None and self.process.returncode is None:
            self.process.terminate()
            try:
                await asyncio.wait_for(self.process.wait(), timeout=2)
            except TimeoutError:
                self.process.kill()
                await self.process.wait()
        if self._stderr_task is not None:
            self._stderr_task.cancel()
            await asyncio.gather(self._stderr_task, return_exceptions=True)

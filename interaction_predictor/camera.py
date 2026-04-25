from __future__ import annotations

import asyncio
import concurrent.futures
import json
import logging
import os
import platform
import re
import shutil
import subprocess
from collections import deque
from dataclasses import dataclass
from functools import partial
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


RTMP_STREAM_SCHEMES = ("rtmp://", "rtmps://")
NETWORK_STREAM_SCHEMES = ("http://", "https://", "rtsp://", *RTMP_STREAM_SCHEMES)


def is_browser_source(source: str) -> bool:
    return source.startswith("browser:")


def is_rtmp_source(source: str) -> bool:
    return source.lower().startswith(RTMP_STREAM_SCHEMES)


def is_network_stream_source(source: str) -> bool:
    return source.lower().startswith(NETWORK_STREAM_SCHEMES)


def _network_stream_scheme(source: str) -> str | None:
    if "://" not in source:
        return None
    return source.split("://", 1)[0].lower()


def _resolution_payload(resolution: tuple[int, int] | None) -> dict[str, int] | None:
    if resolution is None:
        return None
    width, height = resolution
    return {"width": width, "height": height}


def _actual_resolution_from_image(image: np.ndarray) -> dict[str, int]:
    height, width = image.shape[:2]
    return {"width": int(width), "height": int(height)}


def _capture_resolution(cap: cv2.VideoCapture) -> dict[str, int]:
    return {
        "width": int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0),
        "height": int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0),
    }


def _apply_capture_resolution(
    cap: cv2.VideoCapture,
    resolution: tuple[int, int] | None,
) -> None:
    if resolution is None:
        return
    width, height = resolution
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)


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
    if is_rtmp_source(source):
        return f"RTMP 直播流 {source}"
    if is_network_stream_source(source):
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
        current_is_stream = is_network_stream_source(current_source)
        current_scheme = _network_stream_scheme(current_source)
        sources.insert(
            0,
            CameraSource(
                id="current",
                source=current_source,
                label=f"当前输入 {_source_label(current_source)}",
                type="stream" if current_is_stream else "custom",
                available=True,
                details={
                    "source": current_source,
                    "scheme": current_scheme,
                    "live": is_rtmp_source(current_source) or current_scheme == "rtsp",
                },
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
        resolution: tuple[int, int] | None = None,
    ) -> None:
        self._source = source
        self._resolution = resolution
        self.fps_limit = fps_limit
        self.reconnect_sec = reconnect_sec
        self.status: dict[str, Any] = {
            "connected": False,
            "source": source,
            "requested_resolution": _resolution_payload(resolution),
        }
        self._frame_id = 0
        self._source_lock = asyncio.Lock()
        self._switch_event = asyncio.Event()
        self._io_executor = concurrent.futures.ThreadPoolExecutor(
            max_workers=1,
            thread_name_prefix="camera-io",
        )

    def close(self) -> None:
        self._io_executor.shutdown(wait=False, cancel_futures=True)

    async def get_source(self) -> str:
        async with self._source_lock:
            return self._source

    async def get_resolution(self) -> dict[str, int] | None:
        async with self._source_lock:
            return _resolution_payload(self._resolution)

    async def set_resolution(self, resolution: tuple[int, int] | None) -> dict[str, Any]:
        async with self._source_lock:
            changed = resolution != self._resolution
            if not changed:
                return {"resolution": _resolution_payload(self._resolution), "changed": False}
            self._resolution = resolution
            self.status = {
                **self.status,
                "connected": False,
                "source": self._source,
                "requested_resolution": _resolution_payload(resolution),
                "switching": True,
            }
            self._switch_event.set()
            return {"resolution": _resolution_payload(resolution), "changed": True}

    async def set_source(
        self,
        source: str,
        *,
        resolution: tuple[int, int] | None = None,
        resolution_provided: bool = False,
    ) -> dict[str, Any]:
        async with self._source_lock:
            next_resolution = resolution if resolution_provided else self._resolution
            source_changed = source != self._source
            resolution_changed = next_resolution != self._resolution
            changed = source_changed or resolution_changed
            if not changed:
                return {
                    "source": source,
                    "resolution": _resolution_payload(self._resolution),
                    "changed": False,
                }
            self._source = source
            self._resolution = next_resolution
            self.status = {
                "connected": False,
                "source": source,
                "requested_resolution": _resolution_payload(self._resolution),
                "switching": True,
            }
            self._switch_event.set()
            return {
                "source": source,
                "resolution": _resolution_payload(self._resolution),
                "changed": True,
                "source_changed": source_changed,
                "resolution_changed": resolution_changed,
            }

    async def _current_source_and_resolution(self) -> tuple[str, tuple[int, int] | None]:
        async with self._source_lock:
            return self._source, self._resolution

    async def run(self, frame_buffer: FrameBuffer) -> None:
        min_delay = 1.0 / self.fps_limit if self.fps_limit > 0 else 0.0
        while True:
            source, resolution = await self._current_source_and_resolution()
            self._switch_event.clear()
            await frame_buffer.clear()
            if is_browser_source(source):
                self.status = {
                    "connected": False,
                    "source": source,
                    "backend": "browser-get-user-media",
                    "requested_resolution": _resolution_payload(resolution),
                    "waiting_for_frame_upload": True,
                }
                while not self._switch_event.is_set() and await self.get_source() == source:
                    await asyncio.sleep(self.reconnect_sec)
                continue

            if _is_avfoundation_source(source):
                await self._run_avfoundation_source(source, resolution, frame_buffer, min_delay)
                continue

            if is_network_stream_source(source) and shutil.which("ffmpeg") is not None:
                await self._run_ffmpeg_network_source(source, resolution, frame_buffer, min_delay)
                continue

            cap = cv2.VideoCapture(_parse_camera_source(source))
            if not cap.isOpened():
                self.status = {
                    "connected": False,
                    "source": source,
                    "requested_resolution": _resolution_payload(resolution),
                    "error": "failed to open camera stream",
                }
                logger.warning("failed to open camera stream: %s", source)
                await asyncio.sleep(self.reconnect_sec)
                continue

            if source.isdigit():
                _apply_capture_resolution(cap, resolution)
            self.status = {
                "connected": True,
                "source": source,
                "requested_resolution": _resolution_payload(resolution),
                "actual_resolution": _capture_resolution(cap),
            }
            try:
                loop = asyncio.get_running_loop()
                while True:
                    if self._switch_event.is_set() or await self.get_source() != source:
                        logger.info("switching camera source from %s", source)
                        break
                    ok, image = await loop.run_in_executor(self._io_executor, cap.read)
                    if not ok or image is None:
                        self.status = {
                            "connected": False,
                            "source": source,
                            "requested_resolution": _resolution_payload(resolution),
                            "actual_resolution": _capture_resolution(cap),
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
                    self.status = {
                        "connected": True,
                        "source": source,
                        "requested_resolution": _resolution_payload(resolution),
                        "actual_resolution": _actual_resolution_from_image(image),
                        "frame_id": self._frame_id,
                    }
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
        resolution: tuple[int, int] | None,
        frame_buffer: FrameBuffer,
        min_delay: float,
    ) -> None:
        index = _parse_avfoundation_source(source)
        if index is None:
            self.status = {
                "connected": False,
                "source": source,
                "requested_resolution": _resolution_payload(resolution),
                "error": "invalid avfoundation source",
            }
            await asyncio.sleep(self.reconnect_sec)
            return
        if shutil.which("ffmpeg") is None:
            self.status = {
                "connected": False,
                "source": source,
                "requested_resolution": _resolution_payload(resolution),
                "error": "ffmpeg is required for avfoundation camera sources",
            }
            await asyncio.sleep(self.reconnect_sec)
            return

        stream = _FfmpegAvfoundationStream(
            index=index,
            fps=30.0,
            resolution=resolution,
            executor=self._io_executor,
        )
        try:
            await stream.start()
            self.status = {
                "connected": False,
                "source": source,
                "backend": "ffmpeg-avfoundation",
                "requested_resolution": _resolution_payload(resolution),
            }
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
                        "requested_resolution": _resolution_payload(resolution),
                        "error": await stream.error_summary(),
                    }
                    logger.warning("avfoundation stream read failed: %s", self.status["error"])
                    break
                self.status = {
                    "connected": True,
                    "source": source,
                    "backend": "ffmpeg-avfoundation",
                    "requested_resolution": _resolution_payload(resolution),
                    "actual_resolution": _actual_resolution_from_image(image),
                }
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

    async def _run_ffmpeg_network_source(
        self,
        source: str,
        resolution: tuple[int, int] | None,
        frame_buffer: FrameBuffer,
        min_delay: float,
    ) -> None:
        stream = _FfmpegNetworkVideoStream(
            source=source,
            resolution=resolution,
            executor=self._io_executor,
        )
        backend = "ffmpeg-rtmp" if is_rtmp_source(source) else "ffmpeg-network"
        try:
            await stream.start()
            self.status = {
                "connected": False,
                "source": source,
                "backend": backend,
                "source_type": "stream",
                "requested_resolution": _resolution_payload(resolution),
            }
            while True:
                if self._switch_event.is_set() or await self.get_source() != source:
                    logger.info("switching camera source from %s", source)
                    break
                image = await stream.read_frame(timeout_sec=max(5.0, self.reconnect_sec))
                if image is None:
                    self.status = {
                        "connected": False,
                        "source": source,
                        "backend": backend,
                        "source_type": "stream",
                        "requested_resolution": _resolution_payload(resolution),
                        "error": await stream.error_summary(),
                    }
                    logger.warning("network stream read failed: %s", self.status["error"])
                    break
                self._frame_id += 1
                self.status = {
                    "connected": True,
                    "source": source,
                    "backend": backend,
                    "source_type": "stream",
                    "requested_resolution": _resolution_payload(resolution),
                    "actual_resolution": _actual_resolution_from_image(image),
                    "frame_id": self._frame_id,
                }
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
            "requested_resolution": await self.get_resolution(),
            "actual_resolution": _actual_resolution_from_image(image),
        }
        return True


class _FfmpegMjpegPipe:
    def __init__(
        self,
        *,
        source_name: str,
        executor: concurrent.futures.Executor,
    ) -> None:
        self.source_name = source_name
        self.executor = executor
        self.process: asyncio.subprocess.Process | None = None
        self._buffer = bytearray()
        self._stderr = bytearray()
        self._stderr_task: asyncio.Task[None] | None = None

    async def _start_command(self, cmd: list[str]) -> None:
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
                loop = asyncio.get_running_loop()
                image = await loop.run_in_executor(
                    self.executor,
                    partial(
                        cv2.imdecode,
                        np.frombuffer(frame_bytes, dtype=np.uint8),
                        cv2.IMREAD_COLOR,
                    ),
                )
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
            return f"{self.source_name} did not produce frames before timeout. stderr: {stderr}"
        return f"{self.source_name} did not produce frames before timeout"

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


class _FfmpegAvfoundationStream(_FfmpegMjpegPipe):
    def __init__(
        self,
        *,
        index: int,
        fps: float,
        resolution: tuple[int, int] | None,
        executor: concurrent.futures.Executor,
    ) -> None:
        super().__init__(source_name="ffmpeg avfoundation source", executor=executor)
        self.index = index
        self.fps = fps
        self.resolution = resolution

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
        ]
        if self.resolution is not None:
            width, height = self.resolution
            cmd.extend(["-video_size", f"{width}x{height}"])
        cmd.extend(
            [
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
        )
        await self._start_command(cmd)


class _FfmpegNetworkVideoStream(_FfmpegMjpegPipe):
    def __init__(
        self,
        *,
        source: str,
        resolution: tuple[int, int] | None,
        executor: concurrent.futures.Executor,
    ) -> None:
        super().__init__(source_name="ffmpeg network stream", executor=executor)
        self.source = source
        self.resolution = resolution

    async def start(self) -> None:
        cmd = [
            "ffmpeg",
            "-hide_banner",
            "-loglevel",
            "warning",
            "-nostdin",
            "-fflags",
            "nobuffer",
            "-flags",
            "low_delay",
            "-avioflags",
            "direct",
            "-probesize",
            "32",
            "-analyzeduration",
            "0",
        ]
        if is_rtmp_source(self.source):
            cmd.extend(["-rtmp_live", "live"])
        cmd.extend(
            [
                "-i",
                self.source,
                "-map",
                "0:v:0",
                "-an",
            ]
        )
        scale_filter = self._scale_filter()
        if scale_filter is not None:
            cmd.extend(["-vf", scale_filter])
        cmd.extend(
            [
                "-q:v",
                "5",
                "-f",
                "image2pipe",
                "-vcodec",
                "mjpeg",
                "pipe:1",
            ]
        )
        await self._start_command(cmd)

    def _scale_filter(self) -> str | None:
        if self.resolution is None:
            return None
        width, height = self.resolution
        return (
            f"scale=w={width}:h={height}:"
            "force_original_aspect_ratio=decrease:force_divisible_by=2"
        )

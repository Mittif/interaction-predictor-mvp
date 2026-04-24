from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path


def _env_float(name: str, default: float) -> float:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return float(value)


def _env_int(name: str, default: int) -> int:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return int(value)


def _env_bool(name: str, default: bool) -> bool:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def normalize_base_url(base_url: str, *, default_scheme: str = "http") -> str:
    if base_url.startswith(("http://", "https://")):
        return base_url.rstrip("/")
    return f"{default_scheme}://{base_url.rstrip('/')}"


@dataclass(slots=True)
class Settings:
    camera_url: str = "0"
    camera_fps_limit: float = 15.0
    camera_reconnect_sec: float = 2.0
    camera_probe_count: int = 6
    camera_demo_video_path: Path = Path("/tmp/interaction-predictor-demo/demo.mp4")
    stream_fps: float = 10.0

    llm_provider: str = "kimi"
    llm_timeout_sec: float = 120.0

    kimi_base_url: str = "https://api.moonshot.cn/v1"
    kimi_model: str = "kimi-k2.6"
    kimi_vision_model: str | None = "kimi-k2.5"
    kimi_api_key: str | None = None

    ollama_base_url: str = "http://office.zhoudians.com:41434"
    ollama_model: str = "qwen3.5:27b"
    ollama_vision_model: str | None = None
    ollama_timeout_sec: float = 120.0

    scene_interval_sec: float = 15.0
    scene_input_mode: str = "image"
    scene_image_max_side: int = 1024
    scene_image_jpeg_quality: int = 85

    yolo_model: str = "yolo11n.pt"
    yolo_fps: float = 5.0
    yolo_confidence: float = 0.25
    yolo_image_size: int = 640
    yolo_device: str | None = None

    interaction_interval_sec: float = 2.0
    interest_stable_duration_sec: float = 2.0
    interest_stable_match_ratio: float = 0.75
    interest_stable_min_samples: int = 4
    min_interest_score: float = 0.25

    storage_dir: Path = Path("data")

    api_host: str = "0.0.0.0"
    api_port: int = 8000
    log_level: str = "info"
    debug: bool = False

    @classmethod
    def from_env(cls) -> "Settings":
        defaults = cls()
        kimi_api_key = os.getenv("MOONSHOT_API_KEY") or os.getenv("KIMI_API_KEY") or None
        kimi_base_url = (
            os.getenv("KIMI_BASE_URL") or os.getenv("MOONSHOT_BASE_URL") or defaults.kimi_base_url
        )
        kimi_model = os.getenv("KIMI_MODEL") or os.getenv("MOONSHOT_MODEL") or defaults.kimi_model
        kimi_vision_model = (
            os.getenv("KIMI_VISION_MODEL")
            or os.getenv("MOONSHOT_VISION_MODEL")
            or defaults.kimi_vision_model
        )
        ollama_vision_model = os.getenv("OLLAMA_VISION_MODEL") or None
        device = os.getenv("YOLO_DEVICE") or None
        return cls(
            camera_url=os.getenv("CAMERA_URL", defaults.camera_url),
            camera_fps_limit=_env_float("CAMERA_FPS_LIMIT", defaults.camera_fps_limit),
            camera_reconnect_sec=_env_float("CAMERA_RECONNECT_SEC", defaults.camera_reconnect_sec),
            camera_probe_count=_env_int("CAMERA_PROBE_COUNT", defaults.camera_probe_count),
            camera_demo_video_path=Path(
                os.getenv("CAMERA_DEMO_VIDEO", str(defaults.camera_demo_video_path))
            ),
            stream_fps=_env_float("STREAM_FPS", defaults.stream_fps),
            llm_provider=os.getenv("LLM_PROVIDER", defaults.llm_provider).lower(),
            llm_timeout_sec=_env_float("LLM_TIMEOUT_SEC", defaults.llm_timeout_sec),
            kimi_base_url=normalize_base_url(kimi_base_url, default_scheme="https"),
            kimi_model=kimi_model,
            kimi_vision_model=kimi_vision_model,
            kimi_api_key=kimi_api_key,
            ollama_base_url=normalize_base_url(
                os.getenv("OLLAMA_BASE_URL", defaults.ollama_base_url),
                default_scheme="http",
            ),
            ollama_model=os.getenv("OLLAMA_MODEL", defaults.ollama_model),
            ollama_vision_model=ollama_vision_model,
            ollama_timeout_sec=_env_float("OLLAMA_TIMEOUT_SEC", defaults.ollama_timeout_sec),
            scene_interval_sec=_env_float("SCENE_INTERVAL_SEC", defaults.scene_interval_sec),
            scene_input_mode=os.getenv("SCENE_INPUT_MODE", defaults.scene_input_mode).lower(),
            scene_image_max_side=_env_int("SCENE_IMAGE_MAX_SIDE", defaults.scene_image_max_side),
            scene_image_jpeg_quality=_env_int(
                "SCENE_IMAGE_JPEG_QUALITY", defaults.scene_image_jpeg_quality
            ),
            yolo_model=os.getenv("YOLO_MODEL", defaults.yolo_model),
            yolo_fps=_env_float("YOLO_FPS", defaults.yolo_fps),
            yolo_confidence=_env_float("YOLO_CONFIDENCE", defaults.yolo_confidence),
            yolo_image_size=_env_int("YOLO_IMAGE_SIZE", defaults.yolo_image_size),
            yolo_device=device,
            interaction_interval_sec=_env_float(
                "INTERACTION_INTERVAL_SEC", defaults.interaction_interval_sec
            ),
            interest_stable_duration_sec=_env_float(
                "INTEREST_STABLE_DURATION_SEC", defaults.interest_stable_duration_sec
            ),
            interest_stable_match_ratio=_env_float(
                "INTEREST_STABLE_MATCH_RATIO", defaults.interest_stable_match_ratio
            ),
            interest_stable_min_samples=_env_int(
                "INTEREST_STABLE_MIN_SAMPLES", defaults.interest_stable_min_samples
            ),
            min_interest_score=_env_float("MIN_INTEREST_SCORE", defaults.min_interest_score),
            storage_dir=Path(os.getenv("STORAGE_DIR", str(defaults.storage_dir))),
            api_host=os.getenv("API_HOST", defaults.api_host),
            api_port=_env_int("API_PORT", defaults.api_port),
            log_level=os.getenv("LOG_LEVEL", defaults.log_level),
            debug=_env_bool("DEBUG", defaults.debug),
        )

    @property
    def active_model(self) -> str:
        if self.llm_provider == "kimi":
            return self.kimi_model
        if self.llm_provider == "ollama":
            return self.ollama_model
        return self.llm_provider

    @property
    def active_vision_model(self) -> str:
        if self.llm_provider == "kimi":
            return self.kimi_vision_model or self.kimi_model
        if self.llm_provider == "ollama":
            return self.ollama_vision_model or self.ollama_model
        return self.active_model

    def with_overrides(
        self,
        *,
        camera_url: str | None = None,
        api_host: str | None = None,
        api_port: int | None = None,
        scene_input_mode: str | None = None,
        llm_provider: str | None = None,
    ) -> "Settings":
        return Settings(
            camera_url=camera_url if camera_url is not None else self.camera_url,
            camera_fps_limit=self.camera_fps_limit,
            camera_reconnect_sec=self.camera_reconnect_sec,
            camera_probe_count=self.camera_probe_count,
            camera_demo_video_path=self.camera_demo_video_path,
            stream_fps=self.stream_fps,
            llm_provider=llm_provider.lower() if llm_provider is not None else self.llm_provider,
            llm_timeout_sec=self.llm_timeout_sec,
            kimi_base_url=self.kimi_base_url,
            kimi_model=self.kimi_model,
            kimi_vision_model=self.kimi_vision_model,
            kimi_api_key=self.kimi_api_key,
            ollama_base_url=self.ollama_base_url,
            ollama_model=self.ollama_model,
            ollama_vision_model=self.ollama_vision_model,
            ollama_timeout_sec=self.ollama_timeout_sec,
            scene_interval_sec=self.scene_interval_sec,
            scene_input_mode=(
                scene_input_mode.lower() if scene_input_mode is not None else self.scene_input_mode
            ),
            scene_image_max_side=self.scene_image_max_side,
            scene_image_jpeg_quality=self.scene_image_jpeg_quality,
            yolo_model=self.yolo_model,
            yolo_fps=self.yolo_fps,
            yolo_confidence=self.yolo_confidence,
            yolo_image_size=self.yolo_image_size,
            yolo_device=self.yolo_device,
            interaction_interval_sec=self.interaction_interval_sec,
            interest_stable_duration_sec=self.interest_stable_duration_sec,
            interest_stable_match_ratio=self.interest_stable_match_ratio,
            interest_stable_min_samples=self.interest_stable_min_samples,
            min_interest_score=self.min_interest_score,
            storage_dir=self.storage_dir,
            api_host=api_host if api_host is not None else self.api_host,
            api_port=api_port if api_port is not None else self.api_port,
            log_level=self.log_level,
            debug=self.debug,
        )

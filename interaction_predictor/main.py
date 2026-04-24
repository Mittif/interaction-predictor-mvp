from __future__ import annotations

import argparse
import logging

import uvicorn

from .app import create_app
from .config import Settings


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Run the interaction predictor MVP service.")
    parser.add_argument("--camera-url", help="Camera source: 0, HTTP URL, RTSP URL, or RTMP URL")
    parser.add_argument("--host", help="API host")
    parser.add_argument("--port", type=int, help="API port")
    parser.add_argument(
        "--scene-mode",
        choices=["detections", "image"],
        help="Global scene input mode. Use image only with a vision-capable model.",
    )
    parser.add_argument(
        "--llm-provider",
        choices=["kimi", "ollama"],
        help="LLM provider. Defaults to LLM_PROVIDER or kimi.",
    )
    return parser


def cli() -> None:
    parser = build_parser()
    args = parser.parse_args()
    settings = Settings.from_env().with_overrides(
        camera_url=args.camera_url,
        api_host=args.host,
        api_port=args.port,
        scene_input_mode=args.scene_mode,
        llm_provider=args.llm_provider,
    )
    logging.basicConfig(
        level=getattr(logging, settings.log_level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    app = create_app(settings)
    uvicorn.run(app, host=settings.api_host, port=settings.api_port, log_level=settings.log_level)


if __name__ == "__main__":
    cli()

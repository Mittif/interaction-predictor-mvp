from __future__ import annotations

from typing import Any, Protocol

from .config import Settings


class JsonLlmClient(Protocol):
    async def close(self) -> None: ...

    async def generate_json(
        self,
        prompt: str,
        *,
        model: str | None = None,
        images: list[str] | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]: ...


def build_llm_client(settings: Settings) -> JsonLlmClient:
    if settings.llm_provider == "kimi":
        from .kimi import KimiClient

        return KimiClient(
            base_url=settings.kimi_base_url,
            api_key=settings.kimi_api_key,
            model=settings.kimi_model,
            timeout_sec=settings.llm_timeout_sec,
        )
    if settings.llm_provider == "ollama":
        from .ollama import OllamaClient

        return OllamaClient(
            base_url=settings.ollama_base_url,
            model=settings.ollama_model,
            timeout_sec=settings.ollama_timeout_sec,
        )
    raise ValueError(f"unsupported LLM_PROVIDER={settings.llm_provider!r}; use kimi or ollama")

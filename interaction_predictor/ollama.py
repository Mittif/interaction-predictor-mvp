from __future__ import annotations

from typing import Any

import httpx

from .utils import parse_json_object


class OllamaClient:
    def __init__(self, *, base_url: str, model: str, timeout_sec: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._client = httpx.AsyncClient(timeout=timeout_sec)

    async def close(self) -> None:
        await self._client.aclose()

    async def generate_json(
        self,
        prompt: str,
        *,
        model: str | None = None,
        images: list[str] | None = None,
        max_tokens: int | None = None,
    ) -> dict[str, Any]:
        payload: dict[str, Any] = {
            "model": model or self.model,
            "prompt": prompt,
            "stream": False,
            "format": "json",
            "options": {
                "temperature": 0.2,
            },
        }
        if max_tokens is not None:
            payload["options"]["num_predict"] = max_tokens
        if images:
            payload["images"] = images

        response = await self._client.post(f"{self.base_url}/api/generate", json=payload)
        response.raise_for_status()
        body = response.json()
        text = body.get("response", "")
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"empty Ollama response: {body}")
        return parse_json_object(text)

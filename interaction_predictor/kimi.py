from __future__ import annotations

from typing import Any

import httpx

from .utils import parse_json_object


class KimiClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_key: str | None,
        model: str,
        timeout_sec: float,
    ) -> None:
        if not api_key:
            raise ValueError(
                "Kimi provider requires MOONSHOT_API_KEY or KIMI_API_KEY in the environment"
            )
        self.base_url = base_url.rstrip("/")
        self.model = model
        self._client = httpx.AsyncClient(
            timeout=timeout_sec,
            headers={
                "Authorization": f"Bearer {api_key}",
                "Content-Type": "application/json",
            },
        )

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
        content: str | list[dict[str, Any]]
        if images:
            content = [
                {
                    "type": "image_url",
                    "image_url": {"url": f"data:image/jpeg;base64,{image}"},
                }
                for image in images
            ]
            content.append({"type": "text", "text": prompt})
        else:
            content = prompt

        payload: dict[str, Any] = {
            "model": model or self.model,
            "messages": [{"role": "user", "content": content}],
            "response_format": {"type": "json_object"},
            "temperature": 0.6,
            "thinking": {"type": "disabled"},
            "stream": False,
        }
        if max_tokens is not None:
            payload["max_tokens"] = max_tokens

        response = await self._client.post(f"{self.base_url}/chat/completions", json=payload)
        try:
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(
                f"Kimi request failed: {response.status_code} {response.text[:1000]}"
            ) from exc
        body = response.json()
        try:
            text = body["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ValueError(f"unexpected Kimi response shape: {body}") from exc
        if not isinstance(text, str) or not text.strip():
            raise ValueError(f"empty Kimi response: {body}")
        return parse_json_object(text)

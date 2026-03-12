import json
import logging
import os
from typing import Optional

from .config import CONFIG

logger = logging.getLogger(__name__)

try:
    from openai import OpenAI
except Exception:
    OpenAI = None  # type: ignore


class LLMClient:
    def __init__(self):
        self.provider = CONFIG.get("llm_provider")
        self.model = CONFIG.get("llm_model")
        self.api_key = CONFIG.get("llm_api_key") or os.environ.get("OPENAI_API_KEY")
        self.base_url = CONFIG.get("llm_base_url") or os.environ.get("OPENAI_BASE_URL")
        self._client: Optional["OpenAI"] = None
        
        if not self.provider or not self.model:
            logger.warning("llm provider and model not configured, LLM features will use fallback")

    @property
    def client(self) -> Optional["OpenAI"]:
        if self._client is not None:
            return self._client
        
        if not self.api_key or not self.model or OpenAI is None:
            return None
        
        self._client = OpenAI(api_key=self.api_key, base_url=self.base_url)
        return self._client

    def is_available(self) -> bool:
        return self.client is not None

    def summarize(self, text: str, max_words: int = 120) -> str:
        if not text:
            return ""
        if not self.is_available():
            return self._fallback_summary(text, max_words)
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "Summarize the content into concise bullet points."},
                    {"role": "user", "content": text}
                ],
                temperature=0.2
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            logger.error(f"LLM summarize error: {e}")
            return self._fallback_summary(text, max_words)

    def extract_knowledge(self, text: str) -> str:
        if not text:
            return ""
        if not self.is_available():
            return self._fallback_knowledge(text)
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "Extract stable, generalizable knowledge as short rules."},
                    {"role": "user", "content": text}
                ],
                temperature=0.2
            )
            return response.choices[0].message.content.strip()
        except Exception as e:
            logger.error(f"LLM extract_knowledge error: {e}")
            return self._fallback_knowledge(text)

    def _fallback_summary(self, text: str, max_words: int) -> str:
        words = text.split()
        return " ".join(words[:max_words])

    def _fallback_knowledge(self, text: str) -> str:
        words = text.split()
        return " ".join(words[:80])



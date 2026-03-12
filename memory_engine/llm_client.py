import os
import json
from typing import Optional
from .config import CONFIG
try:
    from openai import OpenAI
except Exception:
    OpenAI = None

class LLMClient:
    def __init__(self):
        self.api_key = os.environ.get("OPENAI_API_KEY")
        self.model = self._resolve_model()
        self.base_url = self._resolve_base_url()
        self.client = OpenAI(api_key=self.api_key, base_url=self.base_url) if self.api_key and self.model and OpenAI else None

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
        except Exception:
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
        except Exception:
            return self._fallback_knowledge(text)

    def _fallback_summary(self, text: str, max_words: int) -> str:
        words = text.split()
        return " ".join(words[:max_words])

    def _fallback_knowledge(self, text: str) -> str:
        words = text.split()
        return " ".join(words[:80])

    def _resolve_model(self) -> str:
        from_env = (
            os.environ.get("OPENCLAW_LLM_MODEL")
            or os.environ.get("OPENCLAW_MODEL")
        )
        if from_env:
            return from_env
        from_openclaw = self._read_openclaw_primary_model()
        return from_openclaw or (CONFIG.get("llm_model") or "")

    def _resolve_base_url(self) -> Optional[str]:
        return os.environ.get("OPENAI_BASE_URL") or os.environ.get("OPENCLAW_OPENAI_BASE_URL") or CONFIG.get("openai_base_url") or None

    def _read_openclaw_primary_model(self) -> Optional[str]:
        base_dir = CONFIG.get("openclaw_base_path", "~/.openclaw")
        config_path = os.path.expanduser(os.path.join(base_dir, "openclaw.json"))
        if not os.path.exists(config_path):
            return None
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                data = json.load(f) or {}
            agents = data.get("agents", {})
            defaults = agents.get("defaults", {})
            model_cfg = defaults.get("model", {})
            if isinstance(model_cfg, dict):
                primary = model_cfg.get("primary")
                if primary:
                    return primary
            if isinstance(model_cfg, str):
                return model_cfg
        except Exception:
            return None
        return None

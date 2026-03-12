import logging
import os
from typing import List, Optional

from functools import lru_cache
from .config import CONFIG

logger = logging.getLogger(__name__)

try:
    from openai import OpenAI
except Exception:
    OpenAI = None  # type: ignore

_client: Optional["OpenAI"] = None


def _resolve_base_url() -> Optional[str]:
    return (
        os.environ.get("OPENAI_BASE_URL")
        or os.environ.get("OPENCLAW_OPENAI_BASE_URL")
        or CONFIG.get("openai_base_url")
        or None
    )


def _get_client() -> Optional["OpenAI"]:
    global _client
    if _client is not None:
        return _client
    
    if OpenAI is None:
        logger.warning("OpenAI library not installed")
        return None
    
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.warning("OPENAI_API_KEY not set, embedding will return zero vectors")
        return None
    
    base_url = _resolve_base_url()
    _client = OpenAI(api_key=api_key, base_url=base_url)
    return _client


class EmbeddingModule:
    def __init__(self):
        self.model = CONFIG.get("embedding_model") or None
        if not self.model:
            logger.warning("embedding_model not configured, embedding will return zero vectors")
        
    @lru_cache(maxsize=1000)
    def _embed_single(self, text: str) -> tuple:
        client = _get_client()
        if not client or not self.model:
            return tuple([0.0] * 3072)
        try:
            response = client.embeddings.create(
                input=text,
                model=self.model
            )
            return tuple(response.data[0].embedding)
        except Exception as e:
            logger.error(f"Embedding error: {e}")
            return tuple([0.0] * 3072)

    def embed_text(self, texts: List[str]) -> List[List[float]]:
        embeddings = []
        for text in texts:
            emb = self._embed_single(text)
            embeddings.append(list(emb))
        return embeddings
    
    def is_available(self) -> bool:
        return _get_client() is not None and self.model is not None

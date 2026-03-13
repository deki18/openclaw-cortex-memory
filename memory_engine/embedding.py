import logging
import os
from typing import List, Optional

from .config import get_config

logger = logging.getLogger(__name__)

try:
    from openai import OpenAI
except Exception:
    OpenAI = None  # type: ignore

_client: Optional["OpenAI"] = None


def _get_client() -> Optional["OpenAI"]:
    global _client
    if _client is not None:
        return _client
    
    if OpenAI is None:
        logger.warning("OpenAI library not installed")
        return None
    
    config = get_config()
    api_key = config.get("embedding_api_key") or os.environ.get("OPENAI_API_KEY")
    if not api_key:
        logger.warning("API key not set, embedding will return zero vectors")
        return None
    
    base_url = config.get("embedding_base_url") or os.environ.get("OPENAI_BASE_URL")
    _client = OpenAI(api_key=api_key, base_url=base_url) if base_url else OpenAI(api_key=api_key)
    return _client


class EmbeddingCache:
    def __init__(self, max_size: int = 500):
        self._cache: dict = {}
        self._max_size = max_size
        self._access_order: List[str] = []
    
    def get(self, key: str) -> Optional[tuple]:
        if key in self._cache:
            if key in self._access_order:
                self._access_order.remove(key)
            self._access_order.append(key)
            return self._cache[key]
        return None
    
    def set(self, key: str, value: tuple):
        if key in self._cache:
            if key in self._access_order:
                self._access_order.remove(key)
            self._access_order.append(key)
            self._cache[key] = value
            return
        
        if len(self._cache) >= self._max_size:
            oldest_key = self._access_order.pop(0)
            del self._cache[oldest_key]
        
        self._cache[key] = value
        self._access_order.append(key)
    
    def clear(self):
        self._cache.clear()
        self._access_order.clear()
    
    def size(self) -> int:
        return len(self._cache)


_embedding_cache: Optional[EmbeddingCache] = None


def get_embedding_cache() -> EmbeddingCache:
    global _embedding_cache
    if _embedding_cache is None:
        _embedding_cache = EmbeddingCache(max_size=500)
    return _embedding_cache


class EmbeddingModule:
    def __init__(self):
        config = get_config()
        self.provider = config.get("embedding_provider")
        self.model = config.get("embedding_model")
        self.dimensions = config.get("embedding_dimensions") or 3072
        self._cache = get_embedding_cache()
        if not self.provider or not self.model:
            logger.warning("embedding provider and model not configured")
        
    def _get_cache_key(self, text: str) -> str:
        return f"{self.provider}:{self.model}:{hash(text)}"
    
    def _embed_single(self, text: str) -> tuple:
        cache_key = self._get_cache_key(text)
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached
        
        client = _get_client()
        if not client or not self.model:
            return tuple([0.0] * self.dimensions)
        try:
            response = client.embeddings.create(
                input=text,
                model=self.model
            )
            result = tuple(response.data[0].embedding)
            self._cache.set(cache_key, result)
            return result
        except Exception as e:
            logger.error(f"Embedding error: {e}")
            return tuple([0.0] * self.dimensions)

    def embed_text(self, texts: List[str]) -> List[List[float]]:
        embeddings = []
        for text in texts:
            emb = self._embed_single(text)
            embeddings.append(list(emb))
        return embeddings
    
    def is_available(self) -> bool:
        return _get_client() is not None and self.model is not None
    
    def clear_cache(self):
        self._cache.clear()


def clear_all_embedding_caches():
    global _embedding_cache
    if _embedding_cache:
        _embedding_cache.clear()

import logging
import os
import threading
import time
from typing import List, Optional, Dict, Tuple
from collections import OrderedDict

from .config import get_config

logger = logging.getLogger(__name__)

try:
    from openai import OpenAI
except Exception:
    OpenAI = None  # type: ignore

_client: Optional["OpenAI"] = None
_client_lock = threading.Lock()

_pending_requests: Dict[str, Tuple[threading.Event, Optional[List[float]]]] = {}
_pending_lock = threading.Lock()
_request_cooldown: Dict[str, float] = {}
_cooldown_ms = 100


def _get_client() -> Optional["OpenAI"]:
    global _client
    if _client is not None:
        return _client
    
    with _client_lock:
        if _client is not None:
            return _client
        
        if OpenAI is None:
            logger.warning("OpenAI library not installed")
            return None
        
        config = get_config()
        api_key = config.get("embedding_api_key")
        base_url = config.get("embedding_base_url")
        
        logger.info(f"Embedding config - base_url: {base_url}, api_key: {'***' if api_key else 'None'}")
        
        if not api_key:
            logger.warning("API key not set in config, embedding will return zero vectors")
            return None
        
        if base_url:
            logger.info(f"Using custom embedding endpoint: {base_url}")
            _client = OpenAI(api_key=api_key, base_url=base_url)
        else:
            logger.warning("No base_url configured, using default OpenAI endpoint")
            _client = OpenAI(api_key=api_key)
        return _client


def _wait_for_cooldown(model: str):
    with _pending_lock:
        last_time = _request_cooldown.get(model, 0)
        now = time.time() * 1000
        elapsed = now - last_time
        if elapsed < _cooldown_ms:
            time.sleep((_cooldown_ms - elapsed) / 1000)
        _request_cooldown[model] = time.time() * 1000


class EmbeddingCache:
    def __init__(self, max_size: int = 500):
        self._cache: OrderedDict[str, tuple] = OrderedDict()
        self._max_size = max_size
        self._lock = threading.Lock()
    
    def get(self, key: str) -> Optional[tuple]:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                return self._cache[key]
        return None
    
    def set(self, key: str, value: tuple):
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
                self._cache[key] = value
                return
            
            if len(self._cache) >= self._max_size:
                self._cache.popitem(last=False)
            
            self._cache[key] = value
    
    def clear(self):
        with self._lock:
            self._cache.clear()
    
    def size(self) -> int:
        with self._lock:
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
        self._batch_size = 100
        if not self.provider or not self.model:
            logger.warning("embedding provider and model not configured")
        
    def _get_cache_key(self, text: str) -> str:
        return f"{self.provider}:{self.model}:{hash(text)}"
    
    def _embed_single(self, text: str) -> tuple:
        cache_key = self._get_cache_key(text)
        cached = self._cache.get(cache_key)
        if cached is not None:
            return cached
        
        request_key = f"{self.model}:{hash(text)}"
        with _pending_lock:
            if request_key in _pending_requests:
                event, _ = _pending_requests[request_key]
                event.wait(timeout=30)
                with _pending_lock:
                    _, result = _pending_requests.get(request_key, (None, None))
                    if result is not None:
                        return tuple(result)
        
        client = _get_client()
        if not client or not self.model:
            return tuple([0.0] * self.dimensions)
        
        _wait_for_cooldown(self.model)
        
        event = threading.Event()
        with _pending_lock:
            _pending_requests[request_key] = (event, None)
        
        try:
            response = client.embeddings.create(
                input=text,
                model=self.model
            )
            result = tuple(response.data[0].embedding)
            self._cache.set(cache_key, result)
            
            with _pending_lock:
                _pending_requests[request_key] = (event, list(result))
            event.set()
            
            return result
        except Exception as e:
            logger.error(f"Embedding error: {e}")
            with _pending_lock:
                _pending_requests.pop(request_key, None)
            event.set()
            return tuple([0.0] * self.dimensions)
        finally:
            with _pending_lock:
                _pending_requests.pop(request_key, None)

    def embed_text(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        
        results = [None] * len(texts)
        uncached_indices = []
        uncached_texts = []
        
        for i, text in enumerate(texts):
            cache_key = self._get_cache_key(text)
            cached = self._cache.get(cache_key)
            if cached is not None:
                results[i] = list(cached)
            else:
                uncached_indices.append(i)
                uncached_texts.append(text)
        
        if uncached_texts:
            client = _get_client()
            if client and self.model:
                _wait_for_cooldown(self.model)
                
                for batch_start in range(0, len(uncached_texts), self._batch_size):
                    batch_texts = uncached_texts[batch_start:batch_start + self._batch_size]
                    batch_indices = uncached_indices[batch_start:batch_start + self._batch_size]
                    
                    try:
                        response = client.embeddings.create(
                            input=batch_texts,
                            model=self.model
                        )
                        
                        for j, data in enumerate(response.data):
                            idx = batch_indices[j]
                            emb = list(data.embedding)
                            results[idx] = emb
                            cache_key = self._get_cache_key(batch_texts[j])
                            self._cache.set(cache_key, tuple(emb))
                            
                    except Exception as e:
                        logger.error(f"Batch embedding error: {e}")
                        for idx in batch_indices:
                            results[idx] = [0.0] * self.dimensions
            else:
                for idx in uncached_indices:
                    results[idx] = [0.0] * self.dimensions
        
        return results
    
    def is_available(self) -> bool:
        return _get_client() is not None and self.model is not None
    
    def clear_cache(self):
        self._cache.clear()


def clear_all_embedding_caches():
    global _embedding_cache
    if _embedding_cache:
        _embedding_cache.clear()

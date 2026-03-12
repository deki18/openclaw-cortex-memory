import os
from typing import List
from functools import lru_cache
from .config import CONFIG
try:
    from openai import OpenAI
except Exception:
    OpenAI = None

def _resolve_base_url():
    return os.environ.get("OPENAI_BASE_URL") or os.environ.get("OPENCLAW_OPENAI_BASE_URL") or CONFIG.get("openai_base_url") or None

client = OpenAI(
    api_key=os.environ.get("OPENAI_API_KEY", "dummy"),
    base_url=_resolve_base_url()
) if OpenAI else None

class EmbeddingModule:
    def __init__(self):
        self.model = CONFIG.get("embedding_model") or None
        
    @lru_cache(maxsize=1000)
    def _embed_single(self, text: str) -> tuple:
        if not client or not self.model:
            return tuple([0.0] * 3072)
        try:
            response = client.embeddings.create(
                input=text,
                model=self.model
            )
            return tuple(response.data[0].embedding)
        except Exception as e:
            print(f"Embedding error: {e}")
            return tuple([0.0] * 3072)

    def embed_text(self, texts: List[str]) -> List[List[float]]:
        embeddings = []
        for text in texts:
            emb = self._embed_single(text)
            embeddings.append(list(emb))
        return embeddings

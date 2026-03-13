import logging
import os
from typing import List

import requests

from .config import CONFIG

logger = logging.getLogger(__name__)


class Reranker:
    def __init__(self):
        reranker_config = CONFIG.get("reranker_api", {})
        self.provider = CONFIG.get("reranker_provider")
        self.model = reranker_config.get("model", "")
        self.url = reranker_config.get("url")
        self.api_key = CONFIG.get("reranker_api_key") or os.environ.get("RERANKER_API_KEY")

    def is_available(self) -> bool:
        return bool(self.api_key and self.model)

    def rerank(self, query: str, texts: List[str]) -> List[float]:
        if not texts:
            return []
        if not self.is_available():
            return [1.0] * len(texts)
            
        payload = {
            "model": self.model,
            "query": query,
            "texts": texts
        }
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        
        try:
            response = requests.post(self.url, json=payload, headers=headers, timeout=30)
            response.raise_for_status()
            data = response.json()
            
            results = data.get("results", [])
            scores = [0.0] * len(texts)
            for res in results:
                idx = res.get("index")
                if idx is not None and idx < len(scores):
                    scores[idx] = res.get("relevance_score", 0.0)
            return scores
        except requests.exceptions.Timeout:
            logger.warning("Reranker request timed out, using fallback scores")
            return [1.0] * len(texts)
        except requests.exceptions.RequestException as e:
            logger.error(f"Reranker request error: {e}")
            return [1.0] * len(texts)
        except Exception as e:
            logger.error(f"Reranker unexpected error: {e}")
            return [1.0] * len(texts)

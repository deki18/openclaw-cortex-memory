import os
import requests
from typing import List
from .config import CONFIG

class Reranker:
    def __init__(self):
        reranker_config = CONFIG.get("reranker_api", {})
        self.url = reranker_config.get("url", "https://api.siliconflow.cn/v1/rerank")
        self.model = reranker_config.get("model", "BAAI/bge-reranker-v2-m3")
        self.api_key = os.environ.get("RERANKER_API_KEY") or reranker_config.get("api_key")

    def rerank(self, query: str, texts: List[str]) -> List[float]:
        if not texts:
            return []
        if not self.api_key or not self.model:
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
            response = requests.post(self.url, json=payload, headers=headers, timeout=8)
            response.raise_for_status()
            data = response.json()
            
            # Assuming the API returns a list of scores in the same order
            # Adjust according to actual API response format
            results = data.get("results", [])
            # Sort back to original order if needed, or extract scores
            scores = [0.0] * len(texts)
            for res in results:
                idx = res.get("index")
                if idx is not None and idx < len(scores):
                    scores[idx] = res.get("relevance_score", 0.0)
            return scores
        except Exception as e:
            print(f"Reranker error: {e}")
            return [1.0] * len(texts)

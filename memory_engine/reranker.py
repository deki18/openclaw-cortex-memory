import logging
import os
import time
from typing import List

import requests

from .config import get_config

logger = logging.getLogger(__name__)


class Reranker:
    def __init__(self):
        config = get_config()
        reranker_config = config.get("reranker_api", {})
        self.provider = config.get("reranker_provider")
        self.model = reranker_config.get("model", "")
        self.url = reranker_config.get("url")
        self.api_key = config.get("reranker_api_key")
        self.url = self._normalize_url(self.url)
        self.timeout = int(reranker_config.get("timeout", 30))
        self.max_retries = int(reranker_config.get("retries", 2))
        self.retry_backoff = [0.6, 1.2, 2.0]
        self._consecutive_failures = 0
        self._failure_threshold = int(reranker_config.get("failureThreshold", 3))
        self._cooldown_seconds = int(reranker_config.get("cooldownSeconds", 120))
        self._circuit_open_until = 0.0
        
        logger.info(f"Reranker config - provider: {self.provider}, model: {self.model}, url: {self.url}")

    def _normalize_url(self, url: str) -> str:
        if not url:
            return url
        normalized = str(url).strip().rstrip("/")
        if normalized.endswith("/v1"):
            return f"{normalized}/rerank"
        if normalized.endswith("/v1/rerank") or normalized.endswith("/rerank"):
            return normalized
        return normalized

    def is_available(self) -> bool:
        if not (self.api_key and self.model):
            return False
        if time.time() < self._circuit_open_until:
            return False
        return True

    def _record_success(self):
        self._consecutive_failures = 0
        self._circuit_open_until = 0.0

    def _record_failure(self):
        self._consecutive_failures += 1
        if self._consecutive_failures >= self._failure_threshold:
            self._circuit_open_until = time.time() + self._cooldown_seconds
            logger.warning(
                f"Reranker circuit opened for {self._cooldown_seconds}s "
                f"after {self._consecutive_failures} consecutive failures"
            )

    def _extract_scores(self, data: dict, expected_size: int) -> List[float]:
        raw_items = data.get("results")
        if not isinstance(raw_items, list):
            raw_items = data.get("data")
        scores = [1.0] * expected_size
        if isinstance(raw_items, list):
            for i, item in enumerate(raw_items):
                if isinstance(item, (int, float)):
                    if i < expected_size:
                        scores[i] = float(item)
                    continue
                if not isinstance(item, dict):
                    continue
                idx = item.get("index", i)
                if not isinstance(idx, int) or idx < 0 or idx >= expected_size:
                    continue
                score = item.get("relevance_score")
                if score is None:
                    score = item.get("score")
                if isinstance(score, (int, float)):
                    scores[idx] = float(score)
        return scores

    def _request_scores(self, payload: dict, headers: dict, expected_size: int) -> List[float]:
        attempts = max(self.max_retries, 0) + 1
        last_error: Exception = Exception("unknown reranker error")
        for attempt in range(attempts):
            try:
                response = requests.post(self.url, json=payload, headers=headers, timeout=self.timeout)
                if response.status_code >= 500:
                    raise requests.exceptions.HTTPError(
                        f"{response.status_code} Server Error: {response.text[:300]}",
                        response=response,
                    )
                response.raise_for_status()
                data = response.json()
                return self._extract_scores(data, expected_size)
            except requests.exceptions.HTTPError as e:
                last_error = e
                status_code = e.response.status_code if e.response is not None else None
                if status_code is not None and status_code < 500 and status_code != 429:
                    raise
                if attempt < attempts - 1:
                    backoff = self.retry_backoff[min(attempt, len(self.retry_backoff) - 1)]
                    time.sleep(backoff)
            except requests.exceptions.Timeout as e:
                last_error = e
                if attempt < attempts - 1:
                    backoff = self.retry_backoff[min(attempt, len(self.retry_backoff) - 1)]
                    time.sleep(backoff)
            except requests.exceptions.RequestException as e:
                last_error = e
                if attempt < attempts - 1:
                    backoff = self.retry_backoff[min(attempt, len(self.retry_backoff) - 1)]
                    time.sleep(backoff)
        raise last_error

    def rerank(self, query: str, texts: List[str]) -> List[float]:
        if not texts:
            return []
        if not self.is_available():
            return [1.0] * len(texts)
            
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json"
        }
        payload_candidates = [
            {"model": self.model, "query": query, "texts": texts},
            {"model": self.model, "query": query, "documents": texts},
            {"model": self.model, "query": query, "input": texts},
        ]
        
        for payload in payload_candidates:
            try:
                scores = self._request_scores(payload, headers, len(texts))
                self._record_success()
                return scores
            except requests.exceptions.HTTPError as e:
                status_code = e.response.status_code if e.response is not None else None
                if status_code is not None and status_code < 500 and status_code != 429:
                    continue
                self._record_failure()
                logger.error(f"Reranker request error: {e}")
                return [1.0] * len(texts)
            except requests.exceptions.Timeout:
                self._record_failure()
                logger.warning("Reranker request timed out, using fallback scores")
                return [1.0] * len(texts)
            except requests.exceptions.RequestException as e:
                self._record_failure()
                logger.error(f"Reranker request error: {e}")
                return [1.0] * len(texts)
            except Exception as e:
                self._record_failure()
                logger.error(f"Reranker unexpected error: {e}")
                return [1.0] * len(texts)
        self._record_failure()
        logger.error("Reranker request failed for all payload formats")
        return [1.0] * len(texts)

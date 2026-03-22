import json
import logging
import os
import time
from typing import Optional, List, Dict, Any

from .config import get_config

logger = logging.getLogger(__name__)

try:
    from openai import OpenAI, APIError, RateLimitError, APITimeoutError
except Exception:
    OpenAI = None
    APIError = Exception
    RateLimitError = Exception
    APITimeoutError = Exception


class LLMClient:
    MAX_RETRIES = 3
    RETRY_DELAYS = [1, 2, 4]
    DEFAULT_TIMEOUT = 30
    
    def __init__(self):
        config = get_config()
        self.provider = config.get("llm_provider")
        self.model = config.get("llm_model")
        self.api_key = config.get("llm_api_key")
        self.base_url = config.get("llm_base_url")
        self._client: Optional["OpenAI"] = None
        self._consecutive_failures = 0
        self._last_failure_time = 0
        self._circuit_breaker_threshold = 5
        self._circuit_breaker_recovery = 60
        
        logger.info(f"LLM config - provider: {self.provider}, model: {self.model}, base_url: {self.base_url}")
        
        if not self.provider or not self.model:
            logger.warning("llm provider and model not configured, LLM features will use fallback")

    @property
    def client(self) -> Optional["OpenAI"]:
        if self._client is not None:
            return self._client
        
        if not self.api_key or not self.model or OpenAI is None:
            return None
        
        self._client = OpenAI(api_key=self.api_key, base_url=self.base_url, timeout=self.DEFAULT_TIMEOUT)
        return self._client

    def is_available(self) -> bool:
        if self.client is None:
            return False
        
        if self._consecutive_failures >= self._circuit_breaker_threshold:
            elapsed = time.time() - self._last_failure_time
            if elapsed < self._circuit_breaker_recovery:
                return False
            else:
                self._consecutive_failures = 0
        
        return True

    def _record_success(self):
        self._consecutive_failures = 0

    def _record_failure(self):
        self._consecutive_failures += 1
        self._last_failure_time = time.time()

    def _call_with_retry(
        self, 
        messages: List[Dict[str, str]], 
        temperature: float = 0.2,
        max_tokens: int = 1000
    ) -> Optional[str]:
        if not self.is_available():
            return None
        
        last_error = None
        for attempt in range(self.MAX_RETRIES):
            try:
                response = self.client.chat.completions.create(
                    model=self.model,
                    messages=messages,
                    temperature=temperature,
                    max_tokens=max_tokens
                )
                self._record_success()
                return response.choices[0].message.content.strip()
            except RateLimitError as e:
                last_error = e
                if attempt < self.MAX_RETRIES - 1:
                    delay = self.RETRY_DELAYS[attempt] * 2
                    logger.warning(f"Rate limit hit, retrying in {delay}s: {e}")
                    time.sleep(delay)
            except APITimeoutError as e:
                last_error = e
                if attempt < self.MAX_RETRIES - 1:
                    delay = self.RETRY_DELAYS[attempt]
                    logger.warning(f"Timeout, retrying in {delay}s: {e}")
                    time.sleep(delay)
            except APIError as e:
                last_error = e
                if attempt < self.MAX_RETRIES - 1:
                    delay = self.RETRY_DELAYS[attempt]
                    logger.warning(f"API error, retrying in {delay}s: {e}")
                    time.sleep(delay)
            except Exception as e:
                last_error = e
                logger.error(f"Unexpected error in LLM call: {e}")
                break
        
        self._record_failure()
        logger.error(f"LLM call failed after {self.MAX_RETRIES} attempts: {last_error}")
        return None

    def summarize(self, text: str, max_words: int = 120) -> str:
        if not text:
            return ""
        if not self.is_available():
            return self._fallback_summary(text, max_words)
        
        result = self._call_with_retry([
            {"role": "system", "content": "Summarize the content into concise bullet points."},
            {"role": "user", "content": text}
        ])
        
        if result:
            return result
        return self._fallback_summary(text, max_words)

    def extract_knowledge(self, text: str) -> str:
        if not text:
            return ""
        if not self.is_available():
            return self._fallback_knowledge(text)
        
        result = self._call_with_retry([
            {"role": "system", "content": "Extract stable, generalizable knowledge as short rules."},
            {"role": "user", "content": text}
        ])
        
        if result:
            return result
        return self._fallback_knowledge(text)

    def _fallback_summary(self, text: str, max_words: int) -> str:
        words = text.split()
        return " ".join(words[:max_words])

    def _fallback_knowledge(self, text: str) -> str:
        words = text.split()
        return " ".join(words[:80])



import json
import logging
import re
from dataclasses import dataclass, field
from typing import List, Optional

from ..config import get_config
from ..models.memory_unit import StructuredSummary

logger = logging.getLogger(__name__)

try:
    from openai import OpenAI
except Exception:
    OpenAI = None


STRUCTURED_SUMMARY_PROMPT = """Analyze the following text and extract comprehensive structured information.

Text:
{text}

Please provide:
1. A concise summary (2-3 sentences max)
2. Main topic or subject
3. Relevant keywords (3-7 keywords)
4. Named entities mentioned (people, places, organizations, technical terms, etc.)
5. Sentiment (positive, negative, or neutral)
6. Category (one of: fact, instruction, event, conversation, knowledge, technical, daily_log, other)
7. Importance score (0.0-1.0, where 1.0 is highly important)
8. Key facts or insights (bullet points, max 5)
9. Action items or tasks mentioned (if any)
10. Related concepts or topics (if any)

Respond in JSON format:
{{
    "summary_text": "...",
    "main_topic": "...",
    "keywords": ["keyword1", "keyword2"],
    "entities": ["entity1", "entity2"],
    "sentiment": "neutral",
    "category": "fact",
    "importance_score": 0.7,
    "key_facts": ["fact1", "fact2"],
    "action_items": ["action1"],
    "related_concepts": ["concept1"]
}}"""


BATCH_SUMMARY_PROMPT = """Analyze the following texts and extract structured information for each.

Texts:
{texts}

For each text, provide the same structured information as in single text analysis.

Respond as a JSON array:
[
    {{
        "summary_text": "...",
        "main_topic": "...",
        "keywords": ["keyword1"],
        "entities": ["entity1"],
        "sentiment": "neutral",
        "category": "fact",
        "importance_score": 0.7,
        "key_facts": ["fact1"],
        "action_items": [],
        "related_concepts": []
    }},
    ...
]"""


class LLMExtractor:
    def __init__(self, config: dict = None):
        config = config or get_config()
        self.api_key = config.get("llm_api_key")
        self.base_url = config.get("llm_base_url")
        self.model = config.get("llm_model")
        self._client = None
        
        if not self.api_key or not self.model:
            logger.warning("LLM not configured, extraction will use fallback methods")

    @property
    def client(self):
        if self._client is not None:
            return self._client
        
        if not self.api_key or not self.model or OpenAI is None:
            return None
        
        self._client = OpenAI(api_key=self.api_key, base_url=self.base_url)
        return self._client

    def is_available(self) -> bool:
        return self.client is not None

    def extract(self, text: str) -> StructuredSummary:
        if not text or not text.strip():
            return StructuredSummary.create(summary_text="")
        
        if not self.is_available():
            return self._fallback_extract(text)
        
        try:
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "You are a precise information extraction assistant. Always respond with valid JSON."},
                    {"role": "user", "content": STRUCTURED_SUMMARY_PROMPT.format(text=text[:3000])}
                ],
                temperature=0.1,
                max_tokens=800
            )
            
            content = response.choices[0].message.content.strip()
            return self._parse_response(content)
        except Exception as e:
            logger.error(f"LLM extraction error: {e}")
            return self._fallback_extract(text)

    def batch_extract(self, texts: List[str]) -> List[StructuredSummary]:
        if not texts:
            return []
        
        if not self.is_available():
            return [self._fallback_extract(t) for t in texts]
        
        if len(texts) == 1:
            return [self.extract(texts[0])]
        
        try:
            formatted_texts = "\n\n---\n\n".join([f"[{i}] {t[:500]}" for i, t in enumerate(texts[:10])])
            
            response = self.client.chat.completions.create(
                model=self.model,
                messages=[
                    {"role": "system", "content": "You are a precise information extraction assistant. Always respond with valid JSON array."},
                    {"role": "user", "content": BATCH_SUMMARY_PROMPT.format(texts=formatted_texts)}
                ],
                temperature=0.1,
                max_tokens=3000
            )
            
            content = response.choices[0].message.content.strip()
            results = self._parse_batch_response(content)
            
            while len(results) < len(texts):
                results.append(self._fallback_extract(texts[len(results)]))
            
            return results[:len(texts)]
        except Exception as e:
            logger.error(f"Batch extraction error: {e}")
            return [self._fallback_extract(t) for t in texts]

    def _parse_response(self, content: str) -> StructuredSummary:
        try:
            json_match = re.search(r'\{[\s\S]*\}', content)
            if json_match:
                data = json.loads(json_match.group())
                return StructuredSummary.create(
                    summary_text=data.get("summary_text", "")[:500],
                    main_topic=data.get("main_topic", "")[:100],
                    keywords=data.get("keywords", [])[:7],
                    entities=data.get("entities", [])[:10],
                    sentiment=data.get("sentiment", "neutral"),
                    category=data.get("category", "other"),
                    importance_score=min(1.0, max(0.0, float(data.get("importance_score", 0.5)))),
                    key_facts=data.get("key_facts", [])[:5],
                    action_items=data.get("action_items", [])[:5],
                    related_concepts=data.get("related_concepts", [])[:5]
                )
        except Exception as e:
            logger.warning(f"Failed to parse LLM response: {e}")
        
        return StructuredSummary.create(summary_text=content[:200])

    def _parse_batch_response(self, content: str) -> List[StructuredSummary]:
        results = []
        try:
            json_match = re.search(r'\[[\s\S]*\]', content)
            if json_match:
                data_list = json.loads(json_match.group())
                for data in data_list:
                    results.append(StructuredSummary.create(
                        summary_text=data.get("summary_text", "")[:500],
                        main_topic=data.get("main_topic", "")[:100],
                        keywords=data.get("keywords", [])[:7],
                        entities=data.get("entities", [])[:10],
                        sentiment=data.get("sentiment", "neutral"),
                        category=data.get("category", "other"),
                        importance_score=min(1.0, max(0.0, float(data.get("importance_score", 0.5)))),
                        key_facts=data.get("key_facts", [])[:5],
                        action_items=data.get("action_items", [])[:5],
                        related_concepts=data.get("related_concepts", [])[:5]
                    ))
        except Exception as e:
            logger.warning(f"Failed to parse batch response: {e}")
        
        return results

    def _fallback_extract(self, text: str) -> StructuredSummary:
        sentences = re.split(r'[。！？.!?]', text)
        summary = sentences[0] if sentences else text[:200]
        
        words = re.findall(r'\b[a-zA-Z]{3,}\b', text.lower())
        word_freq = {}
        for word in words:
            word_freq[word] = word_freq.get(word, 0) + 1
        
        keywords = sorted(word_freq.keys(), key=lambda w: word_freq[w], reverse=True)[:7]
        
        entities = self._extract_entities_regex(text)
        
        importance = self._calculate_importance(text)
        
        sentiment = self._analyze_sentiment(text)
        
        return StructuredSummary.create(
            summary_text=summary[:500],
            main_topic=keywords[0] if keywords else "",
            keywords=keywords,
            entities=entities,
            sentiment=sentiment,
            category=self._categorize(text),
            importance_score=importance,
            key_facts=[],
            action_items=[],
            related_concepts=[]
        )

    def _extract_entities_regex(self, text: str) -> List[str]:
        entities = []
        
        capitalized = re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', text)
        entities.extend(capitalized[:5])
        
        numbers = re.findall(r'\b\d+(?:\.\d+)?(?:\s*(?:%|percent|years?|days?|hours?|minutes?))?\b', text)
        entities.extend(numbers[:3])
        
        return list(set(entities))[:10]

    def _calculate_importance(self, text: str) -> float:
        score = 0.5
        
        importance_keywords = [
            "important", "critical", "essential", "key", "must", "required",
            "remember", "note", "warning", "error", "success", "failed",
            "重要", "关键", "必须", "注意", "警告", "成功", "失败"
        ]
        
        text_lower = text.lower()
        for keyword in importance_keywords:
            if keyword in text_lower:
                score += 0.1
        
        if len(text) > 500:
            score += 0.1
        if len(text) > 1000:
            score += 0.1
        
        return min(1.0, score)

    def _analyze_sentiment(self, text: str) -> str:
        positive_words = [
            "good", "great", "excellent", "success", "happy", "love", "best",
            "好", "优秀", "成功", "开心", "喜欢", "最好"
        ]
        
        negative_words = [
            "bad", "terrible", "fail", "error", "sad", "hate", "worst",
            "坏", "糟糕", "失败", "错误", "难过", "讨厌", "最差"
        ]
        
        text_lower = text.lower()
        
        positive_count = sum(1 for word in positive_words if word in text_lower)
        negative_count = sum(1 for word in negative_words if word in text_lower)
        
        if positive_count > negative_count:
            return "positive"
        elif negative_count > positive_count:
            return "negative"
        else:
            return "neutral"

    def _categorize(self, text: str) -> str:
        text_lower = text.lower()
        
        if any(word in text_lower for word in ["how to", "step", "tutorial", "guide", "如何", "步骤", "教程"]):
            return "instruction"
        elif any(word in text_lower for word in ["meeting", "event", "schedule", "会议", "事件", "日程"]):
            return "event"
        elif any(word in text_lower for word in ["chat", "talk", "conversation", "对话", "聊天"]):
            return "conversation"
        elif any(word in text_lower for word in ["python", "code", "programming", "api", "function", "代码", "编程"]):
            return "technical"
        elif any(word in text_lower for word in ["today", "yesterday", "diary", "log", "今天", "昨天", "日记", "日志"]):
            return "daily_log"
        elif any(word in text_lower for word in ["fact", "knowledge", "learn", "study", "事实", "知识", "学习"]):
            return "knowledge"
        else:
            return "fact"


class MetadataEnricher:
    def __init__(self, extractor: LLMExtractor = None):
        self.extractor = extractor or LLMExtractor()

    def enrich(self, text: str, base_metadata: dict = None) -> dict:
        base_metadata = base_metadata or {}
        
        structured_summary = self.extractor.extract(text)
        
        return {
            **base_metadata,
            "structured_summary": structured_summary.to_dict(),
            "importance_score": structured_summary.importance_score,
            "category": structured_summary.category
        }

    def batch_enrich(self, texts: List[str], base_metadatas: List[dict] = None) -> List[dict]:
        if not texts:
            return []
        
        base_metadatas = base_metadatas or [{}] * len(texts)
        
        summaries = self.extractor.batch_extract(texts)
        
        results = []
        for i, (text, summary, base_meta) in enumerate(zip(texts, summaries, base_metadatas)):
            results.append({
                **base_meta,
                "structured_summary": summary.to_dict(),
                "importance_score": summary.importance_score,
                "category": summary.category,
                "batch_index": i
            })
        
        return results

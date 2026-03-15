import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from enum import Enum
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)


class QueryIntent(Enum):
    FACT_LOOKUP = "fact_lookup"
    HOW_TO = "how_to"
    RECALL_EVENT = "recall_event"
    FIND_SIMILAR = "find_similar"
    CHECK_STATUS = "check_status"
    COMPARE = "compare"
    LIST_ITEMS = "list_items"
    UNKNOWN = "unknown"


@dataclass
class SearchStrategy:
    category_weights: Dict[str, float] = field(default_factory=dict)
    priority_categories: List[str] = field(default_factory=list)
    
    hot_cache_k_multiplier: float = 1.0
    vector_k_multiplier: float = 1.0
    keyword_k_multiplier: float = 1.0
    graph_k_multiplier: float = 1.0
    episodic_k_multiplier: float = 1.0
    top_k_multiplier: float = 1.0
    
    enable_time_filter: Optional[bool] = None
    enable_rerank: Optional[bool] = None
    
    time_decay_weight_adjustment: float = 0.0
    
    relevance_weight_adjustment: float = 0.0
    recency_weight_adjustment: float = 0.0


INTENT_STRATEGIES = {
    QueryIntent.HOW_TO: SearchStrategy(
        category_weights={"instruction": 0.3, "knowledge": 0.2},
        priority_categories=["instruction", "knowledge"],
        vector_k_multiplier=0.875,
        keyword_k_multiplier=1.17,
    ),
    QueryIntent.FACT_LOOKUP: SearchStrategy(
        category_weights={"fact": 0.3, "knowledge": 0.25},
        priority_categories=["fact", "knowledge"],
    ),
    QueryIntent.RECALL_EVENT: SearchStrategy(
        category_weights={"event": 0.35, "conversation": 0.25, "progress": 0.15},
        priority_categories=["event", "conversation", "progress"],
        enable_time_filter=True,
        time_decay_weight_adjustment=0.1,
        vector_k_multiplier=0.75,
        keyword_k_multiplier=0.83,
        graph_k_multiplier=1.5,
        episodic_k_multiplier=2.0,
    ),
    QueryIntent.FIND_SIMILAR: SearchStrategy(
        vector_k_multiplier=1.25,
        keyword_k_multiplier=0.67,
        enable_rerank=True,
    ),
    QueryIntent.CHECK_STATUS: SearchStrategy(
        category_weights={"progress": 0.3, "event": 0.2},
        enable_time_filter=True,
        time_decay_weight_adjustment=0.2,
        vector_k_multiplier=0.75,
        keyword_k_multiplier=1.0,
        episodic_k_multiplier=1.5,
    ),
    QueryIntent.COMPARE: SearchStrategy(
        graph_k_multiplier=2.5,
        vector_k_multiplier=0.875,
        keyword_k_multiplier=0.83,
        top_k_multiplier=1.5,
    ),
    QueryIntent.LIST_ITEMS: SearchStrategy(
        top_k_multiplier=2.0,
        enable_rerank=False,
        vector_k_multiplier=0.75,
        keyword_k_multiplier=1.33,
    ),
    QueryIntent.UNKNOWN: SearchStrategy(),
}


@dataclass
class ExtractedEntity:
    text: str
    entity_type: str
    start: int = 0
    end: int = 0
    confidence: float = 1.0
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "text": self.text,
            "entity_type": self.entity_type,
            "start": self.start,
            "end": self.end,
            "confidence": self.confidence,
        }


ENTITY_TYPES = {
    "person": {
        "label": "人名",
        "patterns": [],
    },
    "organization": {
        "label": "组织",
        "patterns": [],
    },
    "location": {
        "label": "地点",
        "patterns": [],
    },
    "date": {
        "label": "日期",
        "patterns": [
            r'\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b',
            r'\b(\d{1,2}[-/]\d{1,2}[-/]\d{4})\b',
        ],
    },
    "time": {
        "label": "时间",
        "patterns": [
            r'\b(\d{1,2}:\d{2}(?::\d{2})?)\b',
            r'\b(\d{1,2}\s*(?:am|pm|AM|PM))\b',
        ],
    },
    "datetime": {
        "label": "日期时间",
        "patterns": [],
    },
    "duration": {
        "label": "时长",
        "patterns": [
            r'(\d+)\s*(?:hours?|小时)',
            r'(\d+)\s*(?:minutes?|分钟)',
            r'(\d+)\s*(?:days?|天)',
            r'(\d+)\s*(?:weeks?|周)',
            r'(\d+)\s*(?:months?|个月)',
            r'(\d+)\s*(?:years?|年)',
        ],
    },
    "money": {
        "label": "金额",
        "patterns": [
            r'\b\$\s*(\d+(?:,\d{3})*(?:\.\d{2})?)\b',
            r'\b(\d+(?:,\d{3})*(?:\.\d{2})?)\s*(?:dollars?|美元)\b',
            r'￥\s*(\d+(?:,\d{3})*(?:\.\d{2})?)',
            r'(\d+(?:,\d{3})*(?:\.\d{2})?)\s*(?:元|人民币)',
        ],
    },
    "percentage": {
        "label": "百分比",
        "patterns": [
            r'\b(\d+(?:\.\d+)?)\s*%\b',
            r'(\d+(?:\.\d+)?)\s*百分之',
        ],
    },
    "number": {
        "label": "数值",
        "patterns": [
            r'\b(\d+(?:,\d{3})*(?:\.\d+)?)\b',
        ],
    },
    "url": {
        "label": "网址",
        "patterns": [
            r'\b(https?://[^\s<>"{}|\\^`\[\]]+)\b',
            r'\b(www\.[^\s<>"{}|\\^`\[\]]+)\b',
        ],
    },
    "email": {
        "label": "邮箱",
        "patterns": [
            r'\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b',
        ],
    },
    "phone": {
        "label": "电话",
        "patterns": [
            r'\b(\+?\d{1,3}[-.\s]?\d{3,4}[-.\s]?\d{4,})\b',
            r'\b(\d{3,4}[-.\s]?\d{7,8})\b',
        ],
    },
    "technical_term": {
        "label": "技术术语",
        "patterns": [
            r'\b\w+\.\w+(?:\.\w+)*\b',
            r'\b[a-z]+_[a-z_]+\b',
            r'\b[a-z]+[A-Z][a-zA-Z]*\b',
        ],
    },
    "acronym": {
        "label": "缩写",
        "patterns": [
            r'\b[A-Z]{2,}\b',
        ],
    },
    "product": {
        "label": "产品",
        "patterns": [],
    },
    "event": {
        "label": "事件",
        "patterns": [],
    },
    "concept": {
        "label": "概念",
        "patterns": [],
    },
    "project": {
        "label": "项目",
        "patterns": [],
    },
    "file_path": {
        "label": "文件路径",
        "patterns": [
            r'\b([A-Za-z]:\\[^\s<>"*?|]+)',
            r'\b(/[\w./-]+)',
            r'\b(\w+://[^\s]+)',
        ],
    },
    "code": {
        "label": "代码",
        "patterns": [
            r'`([^`]+)`',
            r'```[\s\S]*?```',
        ],
    },
    "other": {
        "label": "其他",
        "patterns": [],
    },
}


@dataclass
class QueryUnderstanding:
    original_query: str
    intent: QueryIntent
    search_strategy: SearchStrategy
    entities: List[ExtractedEntity]
    keywords: List[str]
    filters: Dict[str, Any]
    confidence: float = 1.0
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "original_query": self.original_query,
            "intent": self.intent.value,
            "search_strategy": {
                "category_weights": self.search_strategy.category_weights,
                "enable_time_filter": self.search_strategy.enable_time_filter,
                "priority_categories": self.search_strategy.priority_categories,
            },
            "entities": [e.to_dict() for e in self.entities],
            "keywords": self.keywords,
            "filters": self.filters,
            "confidence": self.confidence,
        }
    
    def get_entity_texts(self) -> List[str]:
        return [e.text for e in self.entities]
    
    def get_entity_types(self) -> List[str]:
        return [e.entity_type for e in self.entities]
    
    def get_typed_entities(self) -> List[Dict[str, str]]:
        return [{"text": e.text, "type": e.entity_type} for e in self.entities]


class IntentRecognizer:
    INTENT_PATTERNS = {
        QueryIntent.HOW_TO: [
            (r"how\s+(?:to|do|can)\s+i", 1.0),
            (r"what\s+(?:is|are)\s+the\s+steps", 1.0),
            (r"guide\s+(?:me|to)", 0.9),
            (r"如何", 1.0),
            (r"怎么", 0.95),
            (r"怎样", 0.9),
            (r"方法", 0.8),
            (r"步骤", 0.85),
            (r"教程", 0.9),
        ],
        QueryIntent.FACT_LOOKUP: [
            (r"what\s+is", 0.9),
            (r"who\s+is", 0.9),
            (r"where\s+is", 0.85),
            (r"define\s+", 1.0),
            (r"是什么", 1.0),
            (r"是谁", 1.0),
            (r"在哪", 0.8),
            (r"定义", 0.9),
            (r"意思是", 0.85),
        ],
        QueryIntent.RECALL_EVENT: [
            (r"when\s+did", 1.0),
            (r"what\s+happened", 1.0),
            (r"remember\s+when", 0.95),
            (r"last\s+time", 0.9),
            (r"previous\s+", 0.85),
            (r"什么时候", 1.0),
            (r"发生了什么", 1.0),
            (r"上次", 0.95),
            (r"之前", 0.8),
        ],
        QueryIntent.FIND_SIMILAR: [
            (r"similar\s+to", 1.0),
            (r"related\s+to", 0.9),
            (r"类似于", 1.0),
            (r"像.*一样", 0.85),
            (r"相关", 0.8),
        ],
        QueryIntent.CHECK_STATUS: [
            (r"status\s+of", 1.0),
            (r"is\s+(?:it|there)", 0.8),
            (r"check\s+", 0.85),
            (r"状态", 0.95),
            (r"是否", 0.85),
            (r"检查", 0.8),
        ],
        QueryIntent.COMPARE: [
            (r"difference\s+between", 1.0),
            (r"compare\s+", 0.95),
            (r"\bvs\.?\b", 0.9),
            (r"versus", 0.9),
            (r"区别", 1.0),
            (r"比较", 0.9),
            (r"对比", 0.95),
        ],
        QueryIntent.LIST_ITEMS: [
            (r"list\s+", 1.0),
            (r"show\s+(?:all|me)", 0.9),
            (r"列出", 1.0),
            (r"显示所有", 1.0),
            (r"有哪些", 0.95),
        ],
    }

    def recognize(self, query: str) -> tuple:
        query_lower = query.lower().strip()
        best_intent = QueryIntent.UNKNOWN
        best_confidence = 0.0
        
        for intent, patterns in self.INTENT_PATTERNS.items():
            for pattern, base_confidence in patterns:
                if re.search(pattern, query_lower):
                    matched_confidence = base_confidence
                    if matched_confidence > best_confidence:
                        best_intent = intent
                        best_confidence = matched_confidence
        
        if best_intent == QueryIntent.UNKNOWN and self._is_question(query):
            best_intent = QueryIntent.FACT_LOOKUP
            best_confidence = 0.6
        
        return best_intent, best_confidence

    def _is_question(self, query: str) -> bool:
        question_patterns = [
            r'\?$',
            r'^(what|who|where|when|why|how|which)',
            r'^(什么|谁|哪|何时|为什么|如何|哪个)',
        ]
        for pattern in question_patterns:
            if re.search(pattern, query.lower().strip()):
                return True
        return False


class EntityExtractor:
    DATE_PATTERNS = [
        (r'\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b', 'date'),
        (r'\b(\d{1,2}[-/]\d{1,2}[-/]\d{4})\b', 'date'),
    ]
    
    TIME_PATTERNS = [
        (r'\b(\d{1,2}:\d{2}(?::\d{2})?)\b', 'time'),
        (r'\b(\d{1,2}\s*(?:am|pm|AM|PM))\b', 'time'),
    ]
    
    DURATION_PATTERNS = [
        (r'(\d+)\s*(?:hours?|小时)', 'duration'),
        (r'(\d+)\s*(?:minutes?|分钟)', 'duration'),
        (r'(\d+)\s*(?:days?|天)', 'duration'),
        (r'(\d+)\s*(?:weeks?|周)', 'duration'),
        (r'(\d+)\s*(?:months?|个月)', 'duration'),
        (r'(\d+)\s*(?:years?|年)', 'duration'),
    ]
    
    MONEY_PATTERNS = [
        (r'\b\$\s*(\d+(?:,\d{3})*(?:\.\d{2})?)\b', 'money'),
        (r'￥\s*(\d+(?:,\d{3})*(?:\.\d{2})?)', 'money'),
        (r'(\d+(?:,\d{3})*(?:\.\d{2})?)\s*(?:元|人民币)', 'money'),
    ]
    
    PERCENTAGE_PATTERNS = [
        (r'\b(\d+(?:\.\d+)?)\s*%\b', 'percentage'),
    ]
    
    URL_PATTERNS = [
        (r'\b(https?://[^\s<>"{}|\\^`\[\]]+)\b', 'url'),
        (r'\b(www\.[^\s<>"{}|\\^`\[\]]+)\b', 'url'),
    ]
    
    EMAIL_PATTERNS = [
        (r'\b([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})\b', 'email'),
    ]
    
    PHONE_PATTERNS = [
        (r'\b(\+?\d{1,3}[-.\s]?\d{3,4}[-.\s]?\d{4,})\b', 'phone'),
    ]
    
    TECH_PATTERNS = [
        (r'\b\w+\.\w+(?:\.\w+)*\b', 'technical_term'),
        (r'\b[a-z]+_[a-z_]+\b', 'technical_term'),
        (r'\b[a-z]+[A-Z][a-zA-Z]*\b', 'technical_term'),
    ]
    
    ACRONYM_PATTERN = (r'\b([A-Z]{2,})\b', 'acronym')
    
    FILE_PATH_PATTERNS = [
        (r'\b([A-Za-z]:\\[^\s<>"*?|]+)', 'file_path'),
        (r'\b(/[\w./-]+)', 'file_path'),
    ]
    
    PROPER_NOUN_PATTERN = r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b'
    CHINESE_ENTITY_PATTERN = r'[\u4e00-\u9fff]{2,8}'

    def extract(self, text: str) -> List[ExtractedEntity]:
        entities = []
        
        entities.extend(self._extract_by_patterns(text, self.DATE_PATTERNS))
        entities.extend(self._extract_by_patterns(text, self.TIME_PATTERNS))
        entities.extend(self._extract_by_patterns(text, self.DURATION_PATTERNS))
        entities.extend(self._extract_by_patterns(text, self.MONEY_PATTERNS))
        entities.extend(self._extract_by_patterns(text, self.PERCENTAGE_PATTERNS))
        entities.extend(self._extract_by_patterns(text, self.URL_PATTERNS))
        entities.extend(self._extract_by_patterns(text, self.EMAIL_PATTERNS))
        entities.extend(self._extract_by_patterns(text, self.PHONE_PATTERNS))
        entities.extend(self._extract_by_patterns(text, self.FILE_PATH_PATTERNS))
        entities.extend(self._extract_by_patterns(text, [self.ACRONYM_PATTERN]))
        entities.extend(self._extract_by_patterns(text, self.TECH_PATTERNS))
        entities.extend(self._extract_proper_nouns(text))
        entities.extend(self._extract_chinese_entities(text))
        
        entities.sort(key=lambda e: e.start)
        
        return self._remove_overlapping(entities)

    def _extract_by_patterns(
        self, 
        text: str, 
        patterns: List[tuple]
    ) -> List[ExtractedEntity]:
        entities = []
        
        for pattern, entity_type in patterns:
            for match in re.finditer(pattern, text, re.IGNORECASE):
                entity_text = match.group(1) if match.lastindex else match.group(0)
                entities.append(ExtractedEntity(
                    text=entity_text,
                    entity_type=entity_type,
                    start=match.start(),
                    end=match.end(),
                    confidence=0.9,
                ))
        
        return entities

    def _extract_proper_nouns(self, text: str) -> List[ExtractedEntity]:
        entities = []
        
        for match in re.finditer(self.PROPER_NOUN_PATTERN, text):
            if len(match.group(0)) > 2:
                entities.append(ExtractedEntity(
                    text=match.group(0),
                    entity_type='organization',
                    start=match.start(),
                    end=match.end(),
                    confidence=0.7,
                ))
        
        return entities

    def _extract_chinese_entities(self, text: str) -> List[ExtractedEntity]:
        entities = []
        
        for match in re.finditer(self.CHINESE_ENTITY_PATTERN, text):
            word = match.group(0)
            if not self._is_common_word(word):
                entity_type = self._guess_chinese_entity_type(word)
                entities.append(ExtractedEntity(
                    text=word,
                    entity_type=entity_type,
                    start=match.start(),
                    end=match.end(),
                    confidence=0.6,
                ))
        
        return entities

    def _is_common_word(self, word: str) -> bool:
        common_words = {
            "这个", "那个", "什么", "怎么", "如何", "为什么",
            "但是", "因为", "所以", "如果", "虽然", "可以",
            "需要", "应该", "可能", "已经", "还是", "或者",
            "一下", "一点", "一些", "所有", "每个", "任何",
            "今天", "明天", "昨天", "现在", "以后", "之前",
        }
        return word in common_words

    def _guess_chinese_entity_type(self, word: str) -> str:
        if any(kw in word for kw in ["公司", "集团", "科技", "网络", "软件", "银行"]):
            return "organization"
        if any(kw in word for kw in ["省", "市", "县", "区", "镇", "村", "路", "街"]):
            return "location"
        if any(kw in word for kw in ["项目", "计划", "工程"]):
            return "project"
        if any(kw in word for kw in ["会议", "活动", "事件"]):
            return "event"
        return "other"

    def _remove_overlapping(self, entities: List[ExtractedEntity]) -> List[ExtractedEntity]:
        if not entities:
            return []
        
        filtered = [entities[0]]
        
        for entity in entities[1:]:
            last = filtered[-1]
            
            if entity.start >= last.end:
                filtered.append(entity)
            elif len(entity.text) > len(last.text):
                filtered[-1] = entity
        
        return filtered


class KeywordExtractor:
    STOP_WORDS = {
        "the", "a", "an", "is", "are", "was", "were", "be", "been",
        "have", "has", "had", "do", "does", "did", "will", "would",
        "could", "should", "may", "might", "must", "shall", "can",
        "this", "that", "these", "those", "i", "you", "he", "she",
        "it", "we", "they", "me", "him", "her", "us", "them",
        "的", "是", "在", "有", "和", "与", "或", "了", "着", "过",
        "这", "那", "我", "你", "他", "她", "它", "们", "个",
        "就", "也", "都", "还", "要", "会", "能", "说", "对",
    }

    def extract(self, text: str, entities: List[ExtractedEntity]) -> List[str]:
        entity_texts = {e.text.lower() for e in entities}
        
        words = re.findall(r'[\u4e00-\u9fff]+|[a-zA-Z]+', text.lower())
        
        keywords = []
        for word in words:
            if len(word) < 2:
                continue
            if word in self.STOP_WORDS:
                continue
            if word in entity_texts:
                continue
            keywords.append(word)
        
        seen = set()
        unique_keywords = []
        for kw in keywords:
            if kw not in seen:
                seen.add(kw)
                unique_keywords.append(kw)
        
        return unique_keywords[:8]


class FilterExtractor:
    MONTH_NAMES_CN = {
        "一月": 1, "二月": 2, "三月": 3, "四月": 4, "五月": 5, "六月": 6,
        "七月": 7, "八月": 8, "九月": 9, "十月": 10, "十一月": 11, "十二月": 12,
        "1月": 1, "2月": 2, "3月": 3, "4月": 4, "5月": 5, "6月": 6,
        "7月": 7, "8月": 8, "9月": 9, "10月": 10, "11月": 11, "12月": 12,
    }
    
    MONTH_NAMES_EN = {
        "january": 1, "february": 2, "march": 3, "april": 4,
        "may": 5, "june": 6, "july": 7, "august": 8,
        "september": 9, "october": 10, "november": 11, "december": 12,
        "jan": 1, "feb": 2, "mar": 3, "apr": 4,
        "jun": 6, "jul": 7, "aug": 8, "sep": 9,
        "oct": 10, "nov": 11, "dec": 12,
    }
    
    SOURCE_PATTERNS = {
        "manual": ["手动", "手输", "手动输入", "manual"],
        "file_import": ["文件", "导入", "上传", "file", "import", "upload"],
        "api": ["api", "接口"],
        "conversation": ["对话", "聊天", "conversation", "chat"],
        "web": ["网页", "网站", "web", "website"],
        "clipboard": ["剪贴板", "粘贴", "clipboard", "paste"],
    }
    
    AGENT_PATTERNS = {
        "openclaw": ["openclaw"],
        "user": ["用户", "我", "user", "me"],
        "assistant": ["助手", "assistant"],
        "system": ["系统", "system"],
    }

    def extract(self, query: str) -> Dict[str, Any]:
        filters = {}
        
        date_filter = self._extract_date_filter(query)
        if date_filter:
            filters["date"] = date_filter
        
        source_filter = self._extract_source(query)
        if source_filter:
            filters["source"] = source_filter
        
        agent_filter = self._extract_agent(query)
        if agent_filter:
            filters["agent"] = agent_filter
        
        limit = self._extract_limit(query)
        if limit:
            filters["limit"] = limit
        
        return filters

    def _extract_date_filter(self, query: str) -> Optional[Dict[str, Any]]:
        query_lower = query.lower()
        today = datetime.now(timezone.utc).date()
        
        if "今天" in query or "today" in query_lower:
            return {
                "type": "exact",
                "value": today.strftime("%Y-%m-%d"),
            }
        
        if "昨天" in query or "yesterday" in query_lower:
            yesterday = today - timedelta(days=1)
            return {
                "type": "exact",
                "value": yesterday.strftime("%Y-%m-%d"),
            }
        
        if "前天" in query:
            day_before = today - timedelta(days=2)
            return {
                "type": "exact",
                "value": day_before.strftime("%Y-%m-%d"),
            }
        
        if "大前天" in query:
            day_before = today - timedelta(days=3)
            return {
                "type": "exact",
                "value": day_before.strftime("%Y-%m-%d"),
            }
        
        if "明天" in query or "tomorrow" in query_lower:
            tomorrow = today + timedelta(days=1)
            return {
                "type": "exact",
                "value": tomorrow.strftime("%Y-%m-%d"),
            }
        
        if "后天" in query:
            day_after = today + timedelta(days=2)
            return {
                "type": "exact",
                "value": day_after.strftime("%Y-%m-%d"),
            }
        
        if "这周" in query or "本周" in query or "this week" in query_lower:
            start = today - timedelta(days=today.weekday())
            end = start + timedelta(days=6)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        if "上周" in query or "last week" in query_lower:
            start = today - timedelta(days=today.weekday() + 7)
            end = start + timedelta(days=6)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        if "下周" in query or "next week" in query_lower:
            start = today + timedelta(days=7 - today.weekday())
            end = start + timedelta(days=6)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        if "这个月" in query or "本月" in query or "this month" in query_lower:
            start = today.replace(day=1)
            if today.month == 12:
                end = today.replace(year=today.year + 1, month=1, day=1) - timedelta(days=1)
            else:
                end = today.replace(month=today.month + 1, day=1) - timedelta(days=1)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        if "上个月" in query or "last month" in query_lower:
            if today.month == 1:
                start = today.replace(year=today.year - 1, month=12, day=1)
            else:
                start = today.replace(month=today.month - 1, day=1)
            if start.month == 12:
                end = start.replace(year=start.year + 1, month=1, day=1) - timedelta(days=1)
            else:
                end = start.replace(month=start.month + 1, day=1) - timedelta(days=1)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        if "下个月" in query or "next month" in query_lower:
            if today.month == 12:
                start = today.replace(year=today.year + 1, month=1, day=1)
            else:
                start = today.replace(month=today.month + 1, day=1)
            if start.month == 12:
                end = start.replace(year=start.year + 1, month=1, day=1) - timedelta(days=1)
            else:
                end = start.replace(month=start.month + 1, day=1) - timedelta(days=1)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        if "今年" in query or "this year" in query_lower:
            start = today.replace(month=1, day=1)
            end = today.replace(month=12, day=31)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        if "去年" in query or "last year" in query_lower:
            start = today.replace(year=today.year - 1, month=1, day=1)
            end = today.replace(year=today.year - 1, month=12, day=31)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        if "前年" in query:
            start = today.replace(year=today.year - 2, month=1, day=1)
            end = today.replace(year=today.year - 2, month=12, day=31)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        for month_name, month_num in self.MONTH_NAMES_CN.items():
            if month_name in query:
                year = today.year
                if month_num < today.month:
                    pass
                start = today.replace(month=month_num, day=1)
                if month_num == 12:
                    end = start.replace(year=start.year + 1, month=1, day=1) - timedelta(days=1)
                else:
                    end = start.replace(month=month_num + 1, day=1) - timedelta(days=1)
                return {
                    "type": "range",
                    "start": start.strftime("%Y-%m-%d"),
                    "end": end.strftime("%Y-%m-%d"),
                }
        
        for month_name, month_num in self.MONTH_NAMES_EN.items():
            if month_name in query_lower:
                start = today.replace(month=month_num, day=1)
                if month_num == 12:
                    end = start.replace(year=start.year + 1, month=1, day=1) - timedelta(days=1)
                else:
                    end = start.replace(month=month_num + 1, day=1) - timedelta(days=1)
                return {
                    "type": "range",
                    "start": start.strftime("%Y-%m-%d"),
                    "end": end.strftime("%Y-%m-%d"),
                }
        
        year_match = re.search(r'\b(\d{4})\b', query)
        if year_match and "年" in query:
            year = int(year_match.group(1))
            start = today.replace(year=year, month=1, day=1)
            end = today.replace(year=year, month=12, day=31)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        date_match = re.search(r'\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b', query)
        if date_match:
            date_str = date_match.group(1).replace("/", "-")
            return {
                "type": "exact",
                "value": date_str,
            }
        
        days_ago_match = re.search(r'(\d+)\s*(?:天前|天之前)', query)
        if days_ago_match:
            days = int(days_ago_match.group(1))
            target_date = today - timedelta(days=days)
            return {
                "type": "exact",
                "value": target_date.strftime("%Y-%m-%d"),
            }
        
        days_later_match = re.search(r'(\d+)\s*(?:天后|天之后)', query)
        if days_later_match:
            days = int(days_later_match.group(1))
            target_date = today + timedelta(days=days)
            return {
                "type": "exact",
                "value": target_date.strftime("%Y-%m-%d"),
            }
        
        weeks_ago_match = re.search(r'(\d+)\s*(?:周前|个星期前)', query)
        if weeks_ago_match:
            weeks = int(weeks_ago_match.group(1))
            start = today - timedelta(weeks=weeks)
            end = start + timedelta(days=6)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        months_ago_match = re.search(r'(\d+)\s*(?:个月前)', query)
        if months_ago_match:
            months = int(months_ago_match.group(1))
            target_month = today.month - months
            target_year = today.year
            while target_month <= 0:
                target_month += 12
                target_year -= 1
            start = today.replace(year=target_year, month=target_month, day=1)
            if target_month == 12:
                end = start.replace(year=start.year + 1, month=1, day=1) - timedelta(days=1)
            else:
                end = start.replace(month=target_month + 1, day=1) - timedelta(days=1)
            return {
                "type": "range",
                "start": start.strftime("%Y-%m-%d"),
                "end": end.strftime("%Y-%m-%d"),
            }
        
        return None

    def _extract_source(self, query: str) -> Optional[str]:
        query_lower = query.lower()
        for source, patterns in self.SOURCE_PATTERNS.items():
            for pattern in patterns:
                if pattern.lower() in query_lower:
                    return source
        return None

    def _extract_agent(self, query: str) -> Optional[str]:
        query_lower = query.lower()
        for agent, patterns in self.AGENT_PATTERNS.items():
            for pattern in patterns:
                if pattern.lower() in query_lower:
                    return agent
        return None

    def _extract_limit(self, query: str) -> Optional[int]:
        limit_patterns = [
            r'top\s+(\d+)',
            r'first\s+(\d+)',
            r'limit\s+(\d+)',
            r'(\d+)\s*(?:results?|items?|条|个)',
            r'前\s*(\d+)\s*(?:条|个)?',
        ]
        
        for pattern in limit_patterns:
            match = re.search(pattern, query, re.IGNORECASE)
            if match:
                return min(100, max(1, int(match.group(1))))
        
        return None


class ConfidenceCalculator:
    def calculate(
        self,
        intent: QueryIntent,
        intent_confidence: float,
        entities: List[ExtractedEntity],
        keywords: List[str],
        filters: Dict[str, Any],
    ) -> float:
        scores = {}
        
        scores["intent"] = intent_confidence
        
        entity_score = min(1.0, len(entities) / 5.0) * 0.8 + 0.2
        scores["entities"] = entity_score
        
        keyword_score = min(1.0, len(keywords) / 5.0) * 0.7 + 0.3
        scores["keywords"] = keyword_score
        
        filter_score = 1.0 if filters else 0.5
        scores["filters"] = filter_score
        
        weights = {
            "intent": 0.35,
            "entities": 0.25,
            "keywords": 0.25,
            "filters": 0.15,
        }
        
        final_confidence = sum(scores[k] * weights[k] for k in weights)
        return round(min(1.0, final_confidence), 3)


class QueryUnderstandingPipeline:
    def __init__(self):
        self.intent_recognizer = IntentRecognizer()
        self.entity_extractor = EntityExtractor()
        self.keyword_extractor = KeywordExtractor()
        self.filter_extractor = FilterExtractor()
        self.confidence_calculator = ConfidenceCalculator()

    def understand(self, query: str) -> QueryUnderstanding:
        intent, intent_confidence = self.intent_recognizer.recognize(query)
        
        search_strategy = INTENT_STRATEGIES.get(intent, SearchStrategy())
        
        entities = self.entity_extractor.extract(query)
        
        keywords = self.keyword_extractor.extract(query, entities)
        
        filters = self.filter_extractor.extract(query)
        
        confidence = self.confidence_calculator.calculate(
            intent=intent,
            intent_confidence=intent_confidence,
            entities=entities,
            keywords=keywords,
            filters=filters,
        )
        
        return QueryUnderstanding(
            original_query=query,
            intent=intent,
            search_strategy=search_strategy,
            entities=entities,
            keywords=keywords,
            filters=filters,
            confidence=confidence,
        )

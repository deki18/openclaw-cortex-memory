import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import Dict, List, Optional, Set

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
class ExtractedEntity:
    text: str
    entity_type: str
    start: int
    end: int
    confidence: float = 1.0


@dataclass
class QueryUnderstanding:
    original_query: str
    intent: QueryIntent
    entities: List[ExtractedEntity]
    keywords: List[str]
    expanded_queries: List[str]
    filters: Dict[str, any]
    time_context: Optional[Dict] = None
    confidence: float = 1.0


class IntentRecognizer:
    INTENT_PATTERNS = {
        QueryIntent.HOW_TO: [
            r"how\s+(?:to|do|can)\s+i",
            r"what\s+(?:is|are)\s+the\s+steps",
            r"guide\s+(?:me|to)",
            r"如何", r"怎么", r"怎样",
            r"方法", r"步骤", r"教程"
        ],
        QueryIntent.FACT_LOOKUP: [
            r"what\s+is",
            r"who\s+is",
            r"where\s+is",
            r"when\s+(?:did|was)",
            r"define\s+",
            r"是什么", r"是谁", r"在哪",
            r"定义", r"意思是"
        ],
        QueryIntent.RECALL_EVENT: [
            r"when\s+did",
            r"what\s+happened",
            r"remember\s+when",
            r"last\s+time",
            r"previous\s+",
            r"什么时候", r"发生了什么",
            r"上次", r"之前"
        ],
        QueryIntent.FIND_SIMILAR: [
            r"similar\s+to",
            r"like\s+",
            r"related\s+to",
            r"类似于", r"像", r"相关"
        ],
        QueryIntent.CHECK_STATUS: [
            r"status\s+of",
            r"is\s+(?:it|there)",
            r"check\s+",
            r"状态", r"是否", r"检查"
        ],
        QueryIntent.COMPARE: [
            r"difference\s+between",
            r"compare\s+",
            r"vs\.?",
            r"versus",
            r"区别", r"比较", r"对比"
        ],
        QueryIntent.LIST_ITEMS: [
            r"list\s+",
            r"show\s+(?:all|me)",
            r"what\s+are\s+(?:the\s+)?(?:all\s+)?",
            r"列出", r"显示所有", r"有哪些"
        ]
    }

    def recognize(self, query: str) -> QueryIntent:
        query_lower = query.lower().strip()
        
        for intent, patterns in self.INTENT_PATTERNS.items():
            for pattern in patterns:
                if re.search(pattern, query_lower):
                    return intent
        
        if self._is_question(query):
            return QueryIntent.FACT_LOOKUP
        
        return QueryIntent.UNKNOWN

    def _is_question(self, query: str) -> bool:
        question_patterns = [
            r'\?$',
            r'^(what|who|where|when|why|how|which)',
            r'^(什么|谁|哪|何时|为什么|如何|哪个)'
        ]
        
        for pattern in question_patterns:
            if re.search(pattern, query.lower().strip()):
                return True
        
        return False


class EntityExtractor:
    DATE_PATTERNS = [
        (r'\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b', 'date'),
        (r'\b(\d{1,2}[-/]\d{1,2}[-/]\d{4})\b', 'date'),
        (r'\b(yesterday|today|tomorrow)\b', 'relative_date'),
        (r'\b(last|next|this)\s+(week|month|year)\b', 'relative_date'),
        (r'(昨天|今天|明天|前天|后天)', 'relative_date'),
        (r'(上周|下周|这周|上个月|下个月)', 'relative_date'),
    ]
    
    TIME_PATTERNS = [
        (r'\b(\d{1,2}:\d{2}(?::\d{2})?)\b', 'time'),
        (r'\b(\d{1,2}\s*(?:am|pm|AM|PM))\b', 'time'),
        (r'(早上|上午|中午|下午|晚上|凌晨)', 'time_period'),
    ]
    
    NUMBER_PATTERNS = [
        (r'\b(\d+(?:\.\d+)?)\s*(?:%|percent)\b', 'percentage'),
        (r'\b\$\s*(\d+(?:,\d{3})*(?:\.\d{2})?)\b', 'money'),
        (r'\b(\d+(?:,\d{3})*)\b', 'number'),
    ]

    def extract(self, text: str) -> List[ExtractedEntity]:
        entities = []
        
        entities.extend(self._extract_by_patterns(text, self.DATE_PATTERNS))
        entities.extend(self._extract_by_patterns(text, self.TIME_PATTERNS))
        entities.extend(self._extract_by_patterns(text, self.NUMBER_PATTERNS))
        entities.extend(self._extract_proper_nouns(text))
        entities.extend(self._extract_technical_terms(text))
        
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
                entities.append(ExtractedEntity(
                    text=match.group(1) if match.lastindex else match.group(0),
                    entity_type=entity_type,
                    start=match.start(),
                    end=match.end()
                ))
        
        return entities

    def _extract_proper_nouns(self, text: str) -> List[ExtractedEntity]:
        entities = []
        
        pattern = r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b'
        for match in re.finditer(pattern, text):
            if len(match.group(0)) > 2:
                entities.append(ExtractedEntity(
                    text=match.group(0),
                    entity_type='proper_noun',
                    start=match.start(),
                    end=match.end()
                ))
        
        return entities

    def _extract_technical_terms(self, text: str) -> List[ExtractedEntity]:
        entities = []
        
        tech_patterns = [
            (r'\b[A-Z]{2,}\b', 'acronym'),
            (r'\b\w+\.\w+(?:\.\w+)*\b', 'namespace'),
            (r'\b[a-z]+_[a-z_]+\b', 'snake_case'),
            (r'\b[a-z]+[A-Z][a-zA-Z]*\b', 'camelCase'),
        ]
        
        for pattern, entity_type in tech_patterns:
            for match in re.finditer(pattern, text):
                if len(match.group(0)) > 2:
                    entities.append(ExtractedEntity(
                        text=match.group(0),
                        entity_type=entity_type,
                        start=match.start(),
                        end=match.end()
                    ))
        
        return entities

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


class QueryExpander:
    SYNONYMS = {
        "create": ["make", "build", "generate", "新建", "创建", "建立"],
        "delete": ["remove", "erase", "drop", "删除", "移除"],
        "update": ["modify", "change", "edit", "更新", "修改", "编辑"],
        "find": ["search", "locate", "lookup", "查找", "搜索", "寻找"],
        "error": ["bug", "issue", "problem", "错误", "问题", "故障"],
        "config": ["configuration", "setting", "配置", "设置"],
        "run": ["execute", "start", "launch", "运行", "执行", "启动"],
        "stop": ["halt", "terminate", "end", "停止", "终止", "结束"],
    }
    
    RELATED_TERMS = {
        "api": ["endpoint", "request", "response", "接口"],
        "database": ["sql", "query", "table", "数据库"],
        "file": ["document", "path", "directory", "文件"],
        "user": ["account", "profile", "用户", "账户"],
        "memory": ["recall", "remember", "记忆", "回忆"],
    }

    def expand(self, query: str, max_expansions: int = 3) -> List[str]:
        expansions = [query]
        
        words = re.findall(r'\b\w+\b', query.lower())
        
        for word in words:
            synonyms = self.SYNONYMS.get(word, [])
            for syn in synonyms[:2]:
                expanded = re.sub(
                    r'\b' + re.escape(word) + r'\b',
                    syn,
                    query,
                    flags=re.IGNORECASE
                )
                if expanded not in expansions:
                    expansions.append(expanded)
        
        for word in words:
            related = self.RELATED_TERMS.get(word, [])
            for rel in related[:1]:
                expanded = f"{query} {rel}"
                if expanded not in expansions:
                    expansions.append(expanded)
        
        return expansions[:max_expansions + 1]

    def get_search_variants(self, query: str) -> List[str]:
        variants = [query]
        
        if query.isupper():
            variants.append(query.lower())
        elif query.islower():
            variants.append(query.upper())
        
        words = query.split()
        if len(words) > 1:
            variants.append(' '.join(reversed(words)))
            variants.append(' '.join(words[:len(words)//2 + 1]))
        
        return list(set(variants))[:5]


class QueryFilterExtractor:
    def extract_filters(self, query: str) -> Dict[str, any]:
        filters = {}
        
        date_filter = self._extract_date_filter(query)
        if date_filter:
            filters["date"] = date_filter
        
        type_filter = self._extract_type_filter(query)
        if type_filter:
            filters["memory_type"] = type_filter
        
        limit = self._extract_limit(query)
        if limit:
            filters["limit"] = limit
        
        return filters

    def _extract_date_filter(self, query: str) -> Optional[Dict]:
        query_lower = query.lower()
        
        if "today" in query_lower or "今天" in query:
            return {"type": "exact", "value": "today"}
        
        if "yesterday" in query_lower or "昨天" in query:
            return {"type": "exact", "value": "yesterday"}
        
        if "this week" in query_lower or "这周" in query:
            return {"type": "range", "value": "this_week"}
        
        if "last week" in query_lower or "上周" in query:
            return {"type": "range", "value": "last_week"}
        
        if "this month" in query_lower or "这个月" in query:
            return {"type": "range", "value": "this_month"}
        
        date_match = re.search(r'\b(\d{4}[-/]\d{1,2}[-/]\d{1,2})\b', query)
        if date_match:
            return {"type": "exact", "value": date_match.group(1)}
        
        return None

    def _extract_type_filter(self, query: str) -> Optional[str]:
        type_keywords = {
            "core_rule": ["core rule", "核心规则", "重要规则"],
            "instruction": ["instruction", "guide", "教程", "指南", "说明"],
            "event": ["event", "事件", "发生"],
            "knowledge": ["knowledge", "知识", "学到"],
            "fact": ["fact", "事实", "定义"],
        }
        
        query_lower = query.lower()
        
        for memory_type, keywords in type_keywords.items():
            for keyword in keywords:
                if keyword in query_lower:
                    return memory_type
        
        return None

    def _extract_limit(self, query: str) -> Optional[int]:
        limit_patterns = [
            r'top\s+(\d+)',
            r'first\s+(\d+)',
            r'limit\s+(\d+)',
            r'(\d+)\s*(?:results?|items?)',
            r'前\s*(\d+)',
            r'(\d+)\s*个',
        ]
        
        for pattern in limit_patterns:
            match = re.search(pattern, query, re.IGNORECASE)
            if match:
                return min(100, max(1, int(match.group(1))))
        
        return None


class QueryUnderstandingPipeline:
    def __init__(self):
        self.intent_recognizer = IntentRecognizer()
        self.entity_extractor = EntityExtractor()
        self.query_expander = QueryExpander()
        self.filter_extractor = QueryFilterExtractor()

    def understand(self, query: str) -> QueryUnderstanding:
        intent = self.intent_recognizer.recognize(query)
        
        entities = self.entity_extractor.extract(query)
        
        keywords = self._extract_keywords(query, entities)
        
        expanded_queries = self.query_expander.expand(query)
        
        filters = self.filter_extractor.extract_filters(query)
        
        time_context = self._extract_time_context(entities)
        
        confidence = self._calculate_confidence(intent, entities)
        
        return QueryUnderstanding(
            original_query=query,
            intent=intent,
            entities=entities,
            keywords=keywords,
            expanded_queries=expanded_queries,
            filters=filters,
            time_context=time_context,
            confidence=confidence
        )

    def _extract_keywords(
        self, 
        query: str, 
        entities: List[ExtractedEntity]
    ) -> List[str]:
        entity_texts = {e.text.lower() for e in entities}
        
        stop_words = {
            "the", "a", "an", "is", "are", "was", "were", "be", "been",
            "have", "has", "had", "do", "does", "did", "will", "would",
            "could", "should", "may", "might", "must", "shall", "can",
            "的", "是", "在", "有", "和", "与", "或", "了", "着", "过"
        }
        
        words = re.findall(r'\b\w+\b', query.lower())
        keywords = [w for w in words if w not in stop_words and w not in entity_texts]
        
        return list(set(keywords))[:10]

    def _extract_time_context(
        self, 
        entities: List[ExtractedEntity]
    ) -> Optional[Dict]:
        time_entities = [
            e for e in entities 
            if e.entity_type in ('date', 'relative_date', 'time', 'time_period')
        ]
        
        if not time_entities:
            return None
        
        return {
            "has_time_reference": True,
            "time_entities": [
                {"text": e.text, "type": e.entity_type} 
                for e in time_entities
            ]
        }

    def _calculate_confidence(
        self, 
        intent: QueryIntent, 
        entities: List[ExtractedEntity]
    ) -> float:
        confidence = 0.5
        
        if intent != QueryIntent.UNKNOWN:
            confidence += 0.2
        
        if entities:
            confidence += min(0.2, len(entities) * 0.05)
        
        return min(1.0, confidence)

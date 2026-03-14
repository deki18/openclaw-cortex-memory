import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Dict, List, Optional


class MemoryStatus(Enum):
    ACTIVE = "active"
    ARCHIVED = "archived"
    DELETED = "deleted"


class EntityType(Enum):
    PERSON = "person"
    ORGANIZATION = "organization"
    LOCATION = "location"
    DATE = "date"
    TIME = "time"
    DATETIME = "datetime"
    DURATION = "duration"
    MONEY = "money"
    PERCENTAGE = "percentage"
    NUMBER = "number"
    URL = "url"
    EMAIL = "email"
    PHONE = "phone"
    TECHNICAL_TERM = "technical_term"
    ACRONYM = "acronym"
    PRODUCT = "product"
    EVENT = "event"
    CONCEPT = "concept"
    PROJECT = "project"
    FILE_PATH = "file_path"
    CODE = "code"
    OTHER = "other"


ENTITY_TYPE_LABELS = {
    EntityType.PERSON: "人名",
    EntityType.ORGANIZATION: "组织",
    EntityType.LOCATION: "地点",
    EntityType.DATE: "日期",
    EntityType.TIME: "时间",
    EntityType.DATETIME: "日期时间",
    EntityType.DURATION: "时长",
    EntityType.MONEY: "金额",
    EntityType.PERCENTAGE: "百分比",
    EntityType.NUMBER: "数值",
    EntityType.URL: "网址",
    EntityType.EMAIL: "邮箱",
    EntityType.PHONE: "电话",
    EntityType.TECHNICAL_TERM: "技术术语",
    EntityType.ACRONYM: "缩写",
    EntityType.PRODUCT: "产品",
    EntityType.EVENT: "事件",
    EntityType.CONCEPT: "概念",
    EntityType.PROJECT: "项目",
    EntityType.FILE_PATH: "文件路径",
    EntityType.CODE: "代码",
    EntityType.OTHER: "其他",
}


@dataclass
class Entity:
    text: str
    entity_type: str = "other"
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
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "Entity":
        return cls(
            text=data.get("text", ""),
            entity_type=data.get("entity_type", "other"),
            start=data.get("start", 0),
            end=data.get("end", 0),
            confidence=data.get("confidence", 1.0),
        )
    
    @classmethod
    def create_simple(cls, text: str, entity_type: str = "other") -> "Entity":
        return cls(text=text, entity_type=entity_type)


@dataclass
class StructuredSummary:
    """结构化摘要 - 内容维度
    
    职责：描述文本内容"是什么"
    存储：L1层（结构化摘要层）
    """
    summary_text: str
    main_topic: str = ""
    keywords: List[str] = field(default_factory=list)
    entities: List[Entity] = field(default_factory=list)
    sentiment: str = "neutral"
    category: str = "general"
    importance_score: float = 0.5
    key_facts: List[str] = field(default_factory=list)
    action_items: List[str] = field(default_factory=list)
    related_concepts: List[str] = field(default_factory=list)
    
    @classmethod
    def create(
        cls,
        summary_text: str,
        main_topic: str = "",
        keywords: List[str] = None,
        entities: List[Entity] = None,
        sentiment: str = "neutral",
        category: str = "general",
        importance_score: float = 0.5,
        key_facts: List[str] = None,
        action_items: List[str] = None,
        related_concepts: List[str] = None
    ) -> "StructuredSummary":
        return cls(
            summary_text=summary_text,
            main_topic=main_topic,
            keywords=keywords or [],
            entities=entities or [],
            sentiment=sentiment,
            category=category,
            importance_score=importance_score,
            key_facts=key_facts or [],
            action_items=action_items or [],
            related_concepts=related_concepts or []
        )
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "summary_text": self.summary_text,
            "main_topic": self.main_topic,
            "keywords": self.keywords,
            "entities": [e.to_dict() if isinstance(e, Entity) else e for e in self.entities],
            "sentiment": self.sentiment,
            "category": self.category,
            "importance_score": self.importance_score,
            "key_facts": self.key_facts,
            "action_items": self.action_items,
            "related_concepts": self.related_concepts
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "StructuredSummary":
        entities_data = data.get("entities", [])
        entities = []
        for e in entities_data:
            if isinstance(e, dict):
                entities.append(Entity.from_dict(e))
            elif isinstance(e, Entity):
                entities.append(e)
            elif isinstance(e, str):
                entities.append(Entity.create_simple(e))
        
        return cls(
            summary_text=data.get("summary_text", ""),
            main_topic=data.get("main_topic", ""),
            keywords=data.get("keywords", []),
            entities=entities,
            sentiment=data.get("sentiment", "neutral"),
            category=data.get("category", "general"),
            importance_score=data.get("importance_score", 0.5),
            key_facts=data.get("key_facts", []),
            action_items=data.get("action_items", []),
            related_concepts=data.get("related_concepts", [])
        )
    
    def get_entity_texts(self) -> List[str]:
        return [e.text for e in self.entities]


@dataclass
class SystemMetadata:
    """系统元数据 - 系统维度
    
    职责：描述记录"怎么来的、如何管理"
    存储：最高层级（L2/L1/L0）
    """
    source: str = "manual"
    agent: str = "openclaw"
    memory_type: str = "general"
    batch_id: str = ""
    created_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    updated_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    last_accessed: float = 0.0
    quality_level: str = "medium"
    access_count: int = 0
    storage_tier: str = "warm"
    status: str = "active"
    version: int = 1
    
    @classmethod
    def create(
        cls,
        source: str = "manual",
        agent: str = "openclaw",
        memory_type: str = "general",
        batch_id: str = "",
        quality_level: str = "medium"
    ) -> "SystemMetadata":
        return cls(
            source=source,
            agent=agent,
            memory_type=memory_type,
            batch_id=batch_id,
            quality_level=quality_level
        )
    
    def to_dict(self) -> Dict[str, Any]:
        return {
            "source": self.source,
            "agent": self.agent,
            "memory_type": self.memory_type,
            "batch_id": self.batch_id,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "last_accessed": self.last_accessed,
            "quality_level": self.quality_level,
            "access_count": self.access_count,
            "storage_tier": self.storage_tier,
            "status": self.status,
            "version": self.version
        }
    
    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SystemMetadata":
        now = datetime.now(timezone.utc).timestamp()
        return cls(
            source=data.get("source", "manual"),
            agent=data.get("agent", "openclaw"),
            memory_type=data.get("memory_type", "general"),
            batch_id=data.get("batch_id", ""),
            created_at=data.get("created_at", now),
            updated_at=data.get("updated_at", now),
            last_accessed=data.get("last_accessed", 0.0),
            quality_level=data.get("quality_level", "medium"),
            access_count=data.get("access_count", 0),
            storage_tier=data.get("storage_tier", "warm"),
            status=data.get("status", "active"),
            version=data.get("version", 1)
        )
    
    def update_access(self):
        self.access_count += 1
        self.last_accessed = datetime.now(timezone.utc).timestamp()
    
    def update_timestamp(self):
        self.updated_at = datetime.now(timezone.utc).timestamp()


@dataclass
class Chunk:
    """切片数据
    
    存储：切片层
    元数据：不存储，由父记忆管理
    """
    id: str
    parent_id: str
    text: str
    vector: List[float]
    position: int
    start_pos: int = 0
    end_pos: int = 0

    @classmethod
    def create(
        cls,
        parent_id: str,
        text: str,
        vector: List[float],
        position: int,
        start_pos: int = 0,
        end_pos: int = 0
    ) -> "Chunk":
        return cls(
            id=f"chunk-{uuid.uuid4().hex[:8]}",
            parent_id=parent_id,
            text=text,
            vector=vector,
            position=position,
            start_pos=start_pos,
            end_pos=end_pos
        )


@dataclass
class L0MemoryUnit:
    """L0层记忆单元 - 单句层
    
    存储：极短文本（<100字符，单句）
    元数据：存在L0层（最高层级）
    """
    id: str
    text: str
    vector: List[float]
    metadata: SystemMetadata
    created_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    
    @classmethod
    def create(
        cls,
        text: str,
        vector: List[float],
        metadata: SystemMetadata = None
    ) -> "L0MemoryUnit":
        return cls(
            id=f"L0-{uuid.uuid4().hex[:8]}",
            text=text,
            vector=vector,
            metadata=metadata or SystemMetadata.create()
        )


@dataclass
class L1MemoryUnit:
    """L1层记忆单元 - 结构化摘要层
    
    存储：中等文本（<500字符，1-3句）或 L2的摘要层
    元数据：存在L1层（最高层级，如果没有L2父层）
    """
    id: str
    structured_summary: StructuredSummary
    vector: List[float]
    parent_id: Optional[str] = None
    metadata: Optional[SystemMetadata] = None
    chunks: List[Chunk] = field(default_factory=list)
    created_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    
    @classmethod
    def create(
        cls,
        structured_summary: StructuredSummary,
        vector: List[float],
        parent_id: str = None,
        metadata: SystemMetadata = None,
        chunks: List[Chunk] = None
    ) -> "L1MemoryUnit":
        has_parent = parent_id is not None
        return cls(
            id=f"L1-{uuid.uuid4().hex[:8]}",
            structured_summary=structured_summary,
            vector=vector,
            parent_id=parent_id,
            metadata=None if has_parent else (metadata or SystemMetadata.create()),
            chunks=chunks or []
        )


@dataclass
class L2MemoryUnit:
    """L2层记忆单元 - 原文层
    
    存储：长文本（≥500字符）
    元数据：存在L2层（最高层级）
    """
    id: str
    text: str
    vector: List[float]
    metadata: SystemMetadata
    l1_summary_id: Optional[str] = None
    chunks: List[Chunk] = field(default_factory=list)
    created_at: float = field(default_factory=lambda: datetime.now(timezone.utc).timestamp())
    
    @classmethod
    def create(
        cls,
        text: str,
        vector: List[float],
        metadata: SystemMetadata = None,
        chunks: List[Chunk] = None
    ) -> "L2MemoryUnit":
        return cls(
            id=f"L2-{uuid.uuid4().hex[:8]}",
            text=text,
            vector=vector,
            metadata=metadata or SystemMetadata.create(),
            chunks=chunks or []
        )
    
    def add_chunk(self, chunk: Chunk):
        self.chunks.append(chunk)
    
    def get_chunk_count(self) -> int:
        return len(self.chunks)

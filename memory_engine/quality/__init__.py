import logging
import math
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Dict, List, Optional, Set, Tuple

import numpy as np

logger = logging.getLogger(__name__)


class QualityLevel(Enum):
    HIGH = "high"
    MEDIUM = "medium"
    LOW = "low"
    IRRELEVANT = "irrelevant"


@dataclass
class QualityScore:
    overall: float
    importance: float
    information_density: float
    relevance: float
    clarity: float
    sentiment: float  # 情感得分
    context_awareness: float  # 上下文感知得分
    level: QualityLevel
    reasons: List[str] = field(default_factory=list)
    suggestions: List[str] = field(default_factory=list)


@dataclass
class MemoryQuality:
    score: QualityScore
    tags: List[str]
    category: str
    should_store: bool
    priority: int


class ImportanceScorer:
    KEYWORDS_HIGH = {
        "critical", "essential", "important", "key", "crucial", "vital",
        "must", "required", "mandatory", "urgent", "priority",
        "重要", "关键", "必须", "紧急", "核心", "必要"
    }
    
    KEYWORDS_MEDIUM = {
        "useful", "helpful", "relevant", "notable", "significant",
        "remember", "note", "consider", "worth",
        "有用", "相关", "值得", "注意", "记住"
    }
    
    KEYWORDS_LOW = {
        "maybe", "possibly", "might", "perhaps", "optional",
        "可能", "也许", "可选"
    }
    
    KEYWORDS_IRRELEVANT = {
        "test", "debug", "temp", "temporary", "draft", "example",
        "测试", "临时", "草稿", "示例"
    }

    def __init__(self, config: dict = None):
        config = config or {}
        self.weights = config.get("weights", {
            "keywords": 0.3,
            "length": 0.2,
            "structure": 0.2,
            "entities": 0.15,
            "recency": 0.15
        })

    def score(self, text: str, metadata: dict = None) -> float:
        if not text or not text.strip():
            return 0.0
        
        scores = {}
        
        scores["keywords"] = self._score_keywords(text)
        scores["length"] = self._score_length(text)
        scores["structure"] = self._score_structure(text)
        scores["entities"] = self._score_entities(text)
        scores["recency"] = self._score_recency(metadata)
        
        total = sum(
            scores.get(k, 0) * v 
            for k, v in self.weights.items()
        )
        
        return min(1.0, max(0.0, total))
    
    def _score_recency(self, metadata: dict = None) -> float:
        """基于时效性的评分，使用指数衰减"""
        if not metadata:
            return 1.0
        
        created_at = metadata.get("created_at") or metadata.get("timestamp")
        if not created_at:
            return 1.0
        
        try:
            # 支持多种时间格式
            if isinstance(created_at, (int, float)):
                # Unix时间戳
                created_time = datetime.fromtimestamp(created_at, tz=timezone.utc)
            elif isinstance(created_at, str):
                # ISO格式字符串
                created_time = datetime.fromisoformat(created_at.replace('Z', '+00:00'))
            else:
                return 1.0
            
            now = datetime.now(timezone.utc)
            age_days = (now - created_time).total_seconds() / 86400
            
            # 指数衰减: e^(-age/halflife)
            # 半衰期30天：30天后得分变为0.5
            halflife_days = 30
            score = math.exp(-age_days / halflife_days)
            
            return max(0.1, min(1.0, score))
        except Exception as e:
            logger.debug(f"Error calculating recency: {e}")
            return 1.0

    def _score_keywords(self, text: str) -> float:
        text_lower = text.lower()
        
        high_matches = sum(1 for kw in self.KEYWORDS_HIGH if kw in text_lower)
        medium_matches = sum(1 for kw in self.KEYWORDS_MEDIUM if kw in text_lower)
        low_matches = sum(1 for kw in self.KEYWORDS_LOW if kw in text_lower)
        irrelevant_matches = sum(1 for kw in self.KEYWORDS_IRRELEVANT if kw in text_lower)
        
        score = 0.5
        score += min(0.3, high_matches * 0.1)
        score += min(0.15, medium_matches * 0.05)
        score -= min(0.15, low_matches * 0.05)
        score -= min(0.4, irrelevant_matches * 0.1)
        
        return max(0.0, min(1.0, score))

    def _score_length(self, text: str) -> float:
        """
        使用长度归一化计算得分，防止长条目占据主导地位
        
        设计原则：
        - 太短（<50字符）：信息可能不完整，低分
        - 适中（50-500字符）：最佳区间，高分
        - 较长（500-2000字符）：可接受，中等分数
        - 过长（>2000字符）：可能冗余，适当扣分
        
        使用对数归一化 + 高斯衰减的组合策略
        """
        length = len(text.strip())
        
        if length == 0:
            return 0.0
        
        # 最佳长度区间
        optimal_min = 50
        optimal_max = 500
        optimal_center = (optimal_min + optimal_max) / 2  # 275
        
        # 1. 基础得分：对数归一化（防止长文本主导）
        # 使用 log(1 + length) 来压缩长文本的影响
        max_expected_length = 2000
        log_normalized = math.log(1 + min(length, max_expected_length)) / math.log(1 + max_expected_length)
        
        # 2. 最佳区间奖励：高斯分布，以最佳长度为中心
        # 在最佳区间内得分最高，两边递减
        sigma = 200  # 标准差，控制曲线宽度
        gaussian_score = math.exp(-((length - optimal_center) ** 2) / (2 * sigma ** 2))
        
        # 3. 组合策略：
        # - 短文本：主要受对数归一化影响（低分）
        # - 最佳区间：高斯得分高（高分）
        # - 长文本：对数归一化压缩 + 高斯衰减（中等分数）
        
        if length < optimal_min:
            # 短文本：信息可能不完整
            # 使用对数归一化，但给予一定的起步分
            base_score = 0.3 + 0.4 * log_normalized
            # 额外惩罚过短文本
            if length < 20:
                base_score *= 0.5
            score = base_score
        elif length <= optimal_max:
            # 最佳区间：高分
            # 在区间内，越接近中心得分越高
            distance_from_center = abs(length - optimal_center)
            max_distance = (optimal_max - optimal_min) / 2
            position_score = 1 - (distance_from_center / max_distance) * 0.2  # 最多扣20%
            score = 0.8 + 0.2 * position_score
        elif length <= 2000:
            # 较长但可接受：中等分数，逐渐衰减
            excess = length - optimal_max
            decay_rate = 0.0003  # 每多一个字符扣0.03%
            decay = math.exp(-excess * decay_rate)
            score = 0.75 * decay + 0.25 * log_normalized
        else:
            # 过长：可能冗余，显著扣分
            excess = length - 2000
            # 使用平方根衰减，防止过度惩罚
            penalty = 1 - math.sqrt(excess / (excess + 5000))
            score = 0.5 * penalty * log_normalized
        
        return max(0.1, min(1.0, score))

    def _score_structure(self, text: str) -> float:
        score = 0.5
        
        if re.search(r'[。！？.!?]', text):
            score += 0.1
        
        if re.search(r'\n', text):
            score += 0.1
        
        if re.search(r'[一二三四五六七八九十\d]+[、.]', text):
            score += 0.15
        
        if re.search(r'[•\-\*]\s', text):
            score += 0.1
        
        if re.search(r'[:：]', text):
            score += 0.05
        
        return min(1.0, score)

    def _score_entities(self, text: str) -> float:
        score = 0.5
        
        numbers = len(re.findall(r'\b\d+(?:\.\d+)?(?:%|percent)?\b', text))
        score += min(0.2, numbers * 0.05)
        
        dates = len(re.findall(r'\d{4}[-/]\d{1,2}[-/]\d{1,2}|\d{1,2}[-/]\d{1,2}', text))
        score += min(0.15, dates * 0.05)
        
        proper_nouns = len(re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', text))
        score += min(0.15, proper_nouns * 0.03)
        
        return min(1.0, score)


class InformationDensityCalculator:
    STOP_WORDS = {
        "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
        "have", "has", "had", "do", "does", "did", "will", "would", "could",
        "should", "may", "might", "must", "shall", "can", "need", "dare",
        "的", "是", "在", "有", "和", "与", "或", "了", "着", "过", "这", "那",
        "我", "你", "他", "她", "它", "们", "这个", "那个", "什么", "怎么"
    }

    def calculate(self, text: str) -> float:
        if not text or not text.strip():
            return 0.0
        
        words = text.split()
        if not words:
            return 0.0
        
        content_words = [w for w in words if w.lower() not in self.STOP_WORDS]
        
        unique_content = set(w.lower() for w in content_words)
        
        density = len(unique_content) / len(words) if words else 0
        
        type_score = self._calculate_type_score(text)
        
        return (density * 0.6 + type_score * 0.4)

    def _calculate_type_score(self, text: str) -> float:
        score = 0.0
        
        if re.search(r'\d+(?:\.\d+)?(?:%|percent|years?|days?|hours?)', text):
            score += 0.2
        
        if re.search(r'[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*', text):
            score += 0.2
        
        if re.search(r'https?://\S+|www\.\S+', text):
            score += 0.15
        
        if re.search(r'\b[A-Z]{2,}\b', text):
            score += 0.1
        
        return min(1.0, score)


class AutoTagger:
    CATEGORY_KEYWORDS = {
        "instruction": [
            "how to", "step", "guide", "tutorial", "walkthrough", "procedure",
            "方法", "步骤", "教程", "操作", "流程", "配置", "安装", "部署",
            "设置", "指南", "说明", "怎么做", "如何"
        ],
        
        "fact": [
            "is", "are", "was", "were", "means", "defined as",
            "定义", "是指", "意思是", "本质", "原理", "特性",
            "事实", "实际上", "客观"
        ],
        
        "event": [
            "happened", "occurred", "event", "meeting", "appointment", "conference",
            "会议", "事件", "活动", "日程", "约会", "经历", "访问", "出行",
            "发生", "举行", "参加", "出席"
        ],
        
        "decision": [
            "decided", "chose", "selected", "determined", "concluded",
            "决定", "选择", "确定", "采用", "选定", "方案", "计划",
            "拍板", "定下", "决议", "决策"
        ],
        
        "problem": [
            "error", "issue", "problem", "bug", "failed", "crash", "exception",
            "错误", "问题", "失败", "异常", "故障", "崩溃", "报错",
            "无法", "不能", "不工作", "卡住", "死机", "闪退", "报异常"
        ],
        
        "solution": [
            "solved", "fixed", "resolved", "workaround", "patch",
            "解决", "修复", "方案", "对策", "处理", "绕过", "补丁",
            "修复了", "解决了", "处理了"
        ],
        
        "knowledge": [
            "learned", "discovered", "found", "insight", "understanding",
            "学到", "发现", "了解到", "认识到", "总结", "归纳", "心得",
            "知识", "学习", "理解", "掌握", "原理", "概念"
        ],
        
        "preference": [
            "prefer", "like", "want", "favorite", "recommend",
            "喜欢", "偏好", "想要", "倾向", "习惯", "推荐", "建议",
            "更愿意", "倾向于", "首选"
        ],
        
        "reminder": [
            "remember", "don't forget", "note", "alert", "caution",
            "记住", "别忘了", "注意", "提醒", "警告", "小心", "留意",
            "切记", "谨记", "重视"
        ],
        
        "requirement": [
            "need", "require", "must", "should", "necessary",
            "需求", "需要", "要求", "应该", "必须", "期望", "必要",
            "不可或缺", "必备条件"
        ],
        
        "goal": [
            "goal", "target", "objective", "aim", "milestone",
            "目标", "目的", "计划", "规划", "愿景", "里程碑",
            "指标", "方向", "期望达成"
        ],
        
        "progress": [
            "progress", "status", "update", "ongoing", "pending",
            "进展", "进度", "状态", "更新", "完成", "进行中",
            "已完成", "待处理", "推进"
        ],
        
        "resource": [
            "resource", "link", "reference", "material", "document",
            "资源", "链接", "参考", "资料", "文档", "文献",
            "教程链接", "参考资料", "相关文档"
        ],
        
        "tool": [
            "tool", "software", "app", "plugin", "framework", "library",
            "工具", "软件", "应用", "插件", "库", "框架",
            "组件", "模块", "扩展"
        ],
        
        "performance": [
            "performance", "speed", "optimization", "latency", "throughput",
            "性能", "速度", "优化", "效率", "延迟", "吞吐量",
            "响应时间", "加载", "运行速度"
        ],
        
        "security": [
            "security", "safe", "protect", "auth", "permission",
            "安全", "保护", "认证", "加密", "权限", "漏洞",
            "防护", "隐私", "风险"
        ],
        
        "design": [
            "design", "architecture", "pattern", "structure",
            "设计", "架构", "模式", "结构", "规范", "标准",
            "蓝图", "方案设计", "系统设计"
        ],
        
        "testing": [
            "test", "testing", "verify", "validate", "qa",
            "测试", "验证", "检查", "确认", "单元测试", "集成测试",
            "回归测试", "测试用例"
        ],
        
        "communication": [
            "discuss", "talk", "chat", "feedback", "report",
            "沟通", "讨论", "交流", "对话", "协商", "反馈", "汇报",
            "回复", "通知"
        ],
        
        "data": [
            "data", "dataset", "statistics", "analysis", "report",
            "数据", "数据集", "统计", "分析", "指标", "图表", "报告",
            "数据源", "数据统计"
        ],
        
        "team": [
            "team", "member", "collaborate", "partner",
            "团队", "成员", "协作", "合作", "分工", "角色", "职责",
            "同事", "伙伴", "项目组"
        ]
    }

    def tag(self, text: str, existing_tags: List[str] = None) -> List[str]:
        tags = set(existing_tags or [])
        
        text_lower = text.lower()
        
        for category, keywords in self.CATEGORY_KEYWORDS.items():
            for keyword in keywords:
                if keyword in text_lower:
                    tags.add(category)
                    break
        
        entities = self._extract_entities(text)
        tags.update(entities[:3])
        
        technical_tags = self._extract_technical_tags(text)
        tags.update(technical_tags[:3])
        
        return list(tags)

    def _extract_entities(self, text: str) -> List[str]:
        entities = []
        
        capitalized = re.findall(r'\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)*\b', text)
        entities.extend(capitalized[:5])
        
        dates = re.findall(r'\d{4}[-/]\d{1,2}[-/]\d{1,2}', text)
        entities.extend([f"date:{d}" for d in dates])
        
        return entities

    def _extract_technical_tags(self, text: str) -> List[str]:
        tags = []
        
        tech_patterns = [
            # 编程语言
            (r'\b(python|javascript|typescript|java|go|rust|c\+\+|c#|ruby|php|swift|kotlin|scala|perl|r|matlab)\b', 'programming'),
            (r'\b(html|css|sass|less|scss)\b', 'frontend'),
            (r'\b(shell|bash|powershell|zsh)\b', 'scripting'),
            
            # 前端框架/库
            (r'\b(react|vue|angular|svelte|next\.js|nuxt|electron)\b', 'frontend-framework'),
            (r'\b(jquery|bootstrap|tailwind|antd|material-ui)\b', 'ui-library'),
            
            # 后端框架
            (r'\b(django|flask|fastapi|spring|express|nestjs|laravel|rails)\b', 'backend-framework'),
            
            # 数据库
            (r'\b(database|sql|nosql|mongodb|postgresql|mysql|sqlite|redis|elasticsearch|cassandra)\b', 'database'),
            (r'\b(orm|sqlalchemy|prisma|hibernate|typeorm)\b', 'orm'),
            
            # API相关
            (r'\b(api|rest|graphql|grpc|websocket|openapi|swagger|postman)\b', 'api'),
            (r'\b(json|xml|yaml|protobuf)\b', 'data-format'),
            
            # 基础设施/云
            (r'\b(docker|kubernetes|k8s|aws|azure|gcp|aliyun|tencent-cloud)\b', 'infrastructure'),
            (r'\b(ci/cd|jenkins|github-actions|gitlab-ci|travis)\b', 'cicd'),
            (r'\b(terraform|ansible|puppet|chef)\b', 'iac'),
            (r'\b(linux|ubuntu|centos|debian|windows|macos)\b', 'os'),
            
            # AI/ML
            (r'\b(machine learning|ml|ai|nlp|deep learning|llm|neural network)\b', 'ai'),
            (r'\b(tensorflow|pytorch|sklearn|huggingface|transformers|openai|langchain)\b', 'ml-framework'),
            (r'\b(pandas|numpy|scipy|matplotlib|seaborn|plotly)\b', 'data-science'),
            
            # 版本控制
            (r'\b(git|github|gitlab|bitbucket|svn|mercurial)\b', 'vcs'),
            
            # 编辑器/IDE
            (r'\b(vscode|visual studio|intellij|pycharm|vim|emacs|sublime|atom)\b', 'editor'),
            
            # 测试
            (r'\b(jest|mocha|pytest|unittest|junit|cypress|selenium|playwright)\b', 'testing-tool'),
            (r'\b(tdd|bdd|unit test|integration test|e2e test)\b', 'testing-method'),
            
            # 架构模式
            (r'\b(microservices|monolith|serverless|event-driven|mvc|mvvm|clean architecture)\b', 'architecture'),
            (r'\b(kafka|rabbitmq|redis|memcached|celery|airflow)\b', 'middleware'),
            
            # 安全
            (r'\b(oauth|jwt|sso|ldap|https|ssl|tls|firewall|vpn)\b', 'security'),
            (r'\b(xss|csrf|sql injection|ddos|mitm)\b', 'security-threat'),
            
            # 项目管理
            (r'\b(agile|scrum|kanban|waterfall|jira|trello|asana|notion)\b', 'pm-methodology'),
            (r'\b(sprint|backlog|story|epic|milestone|roadmap)\b', 'pm-term'),
            
            # 网络
            (r'\b(http|https|tcp|udp|ip|dns|cdn|load balancer|proxy)\b', 'network'),
            (r'\b(restful|soap|rpc|grpc|graphql)\b', 'protocol'),
            
            # 数据结构与算法
            (r'\b(algorithm|data structure|big-o|complexity|sorting|searching)\b', 'algorithm'),
            (r'\b(array|list|tree|graph|hash|queue|stack|heap)\b', 'data-structure'),
            
            # 开发概念
            (r'\b(refactoring|debugging|profiling|benchmarking|logging|monitoring)\b', 'dev-practice'),
            (r'\b(design pattern|singleton|factory|observer|strategy|decorator)\b', 'design-pattern'),
        ]
        
        text_lower = text.lower()
        for pattern, tag in tech_patterns:
            if re.search(pattern, text_lower):
                tags.append(tag)
        
        return tags

    def categorize(self, text: str) -> str:
        text_lower = text.lower()
        
        for category, keywords in self.CATEGORY_KEYWORDS.items():
            for keyword in keywords:
                if keyword in text_lower:
                    return category
        
        return "general"


class MemoryQualityEvaluator:
    MIN_QUALITY_THRESHOLD = 0.3
    
    def __init__(self, config: dict = None, embedding_module=None, store=None):
        config = config or {}
        self.importance_scorer = ImportanceScorer(config.get("importance", {}))
        self.density_calculator = InformationDensityCalculator()
        self.auto_tagger = AutoTagger()
        self.min_threshold = config.get("min_threshold", self.MIN_QUALITY_THRESHOLD)
        self.embedding_module = embedding_module
        self.store = store

    def evaluate(self, text: str, metadata: dict = None) -> MemoryQuality:
        importance = self.importance_scorer.score(text, metadata)
        density = self.density_calculator.calculate(text)
        relevance = self._calculate_relevance(text, metadata)
        clarity = self._calculate_clarity(text)
        sentiment = self._calculate_sentiment(text)
        context_awareness = self._calculate_context_awareness(text, metadata)
        
        # 综合评分权重调整
        overall = (
            importance * 0.35 +
            density * 0.20 +
            relevance * 0.15 +
            clarity * 0.15 +
            sentiment * 0.10 +
            context_awareness * 0.05
        )
        
        level = self._determine_level(overall)
        
        reasons, suggestions = self._generate_feedback(
            importance, density, relevance, clarity, sentiment, context_awareness, level
        )
        
        score = QualityScore(
            overall=overall,
            importance=importance,
            information_density=density,
            relevance=relevance,
            clarity=clarity,
            sentiment=sentiment,
            context_awareness=context_awareness,
            level=level,
            reasons=reasons,
            suggestions=suggestions
        )
        
        tags = self.auto_tagger.tag(text, metadata.get("tags", []) if metadata else [])
        category = self.auto_tagger.categorize(text)
        
        should_store = overall >= self.min_threshold
        priority = self._calculate_priority(overall, level)
        
        return MemoryQuality(
            score=score,
            tags=tags,
            category=category,
            should_store=should_store,
            priority=priority
        )

    def _calculate_relevance(self, text: str, metadata: dict) -> float:
        if not metadata:
            return 0.7
        
        score = 0.5
        
        if metadata.get("source"):
            score += 0.2
        
        if metadata.get("context"):
            score += 0.2
        
        if metadata.get("user_provided"):
            score += 0.1
        
        return min(1.0, score)

    def _calculate_clarity(self, text: str) -> float:
        score = 1.0
        
        sentences = re.split(r'[。！？.!?]', text)
        if sentences:
            avg_length = sum(len(s) for s in sentences) / len(sentences)
            if avg_length > 200:
                score -= 0.2
            elif avg_length > 100:
                score -= 0.1
        
        if re.search(r'[^\w\s\u4e00-\u9fff]{3,}', text):
            score -= 0.15
        
        words = text.split()
        if words:
            repeated = len(words) - len(set(w.lower() for w in words))
            repetition_ratio = repeated / len(words)
            score -= repetition_ratio * 0.3
        
        # 语义清晰度：检测语义重复（如果embedding模块可用）
        semantic_clarity = self._calculate_semantic_clarity(text)
        score = score * 0.7 + semantic_clarity * 0.3
        
        return max(0.0, min(1.0, score))
    
    def _calculate_semantic_clarity(self, text: str) -> float:
        """基于embedding的语义清晰度计算"""
        if not self.embedding_module:
            return 1.0
        
        try:
            # 分句
            sentences = [s.strip() for s in re.split(r'[。！？.!?]', text) if s.strip()]
            if len(sentences) < 2:
                return 1.0
            
            # 限制句子数量，避免计算开销过大
            sentences = sentences[:20]
            
            # 获取句子embedding
            embeddings = self.embedding_module.embed_text(sentences)
            if not embeddings or len(embeddings) < 2:
                return 1.0
            
            # 计算余弦相似度矩阵
            embeddings_array = np.array(embeddings)
            norms = np.linalg.norm(embeddings_array, axis=1, keepdims=True)
            normalized = embeddings_array / (norms + 1e-8)
            similarity_matrix = np.dot(normalized, normalized.T)
            
            # 计算平均相似度（排除对角线）
            n = len(sentences)
            mask = ~np.eye(n, dtype=bool)
            avg_similarity = similarity_matrix[mask].mean()
            
            # 相似度过高表示内容重复，扣分
            # 相似度 > 0.9 表示严重重复
            if avg_similarity > 0.9:
                return 0.5
            elif avg_similarity > 0.8:
                return 0.7
            elif avg_similarity > 0.7:
                return 0.85
            else:
                return 1.0
                
        except Exception as e:
            logger.debug(f"Error calculating semantic clarity: {e}")
            return 1.0

    def _determine_level(self, overall: float) -> QualityLevel:
        if overall >= 0.7:
            return QualityLevel.HIGH
        elif overall >= 0.5:
            return QualityLevel.MEDIUM
        elif overall >= 0.3:
            return QualityLevel.LOW
        else:
            return QualityLevel.IRRELEVANT

    def _calculate_sentiment(self, text: str) -> float:
        """简单的情感分析评分"""
        text_lower = text.lower()
        
        # 积极关键词
        positive_words = {
            "good", "great", "excellent", "amazing", "wonderful", "perfect",
            "success", "achieved", "completed", "solved", "happy", "love",
            "优秀", "完美", "成功", "完成", "解决", "喜欢", "开心", "棒"
        }
        
        # 消极关键词
        negative_words = {
            "bad", "terrible", "awful", "failed", "error", "problem", "issue",
            "bug", "crash", "wrong", "hate", "disappointed", "frustrated",
            "糟糕", "失败", "错误", "问题", "故障", "崩溃", "讨厌", "失望"
        }
        
        # 中性/客观关键词（不扣分也不加分）
        neutral_words = {
            "is", "are", "was", "were", "have", "has", "do", "does",
            "是", "有", "在", "和", "与"
        }
        
        positive_count = sum(1 for word in positive_words if word in text_lower)
        negative_count = sum(1 for word in negative_words if word in text_lower)
        
        total = positive_count + negative_count
        if total == 0:
            return 0.8  # 中性内容默认给较高分
        
        # 计算情感倾向得分 (0.0 ~ 1.0)
        # 积极内容得分高，消极内容得分低（但不过低，因为问题记录也有价值）
        sentiment_ratio = positive_count / total
        
        # 调整：消极内容最低0.4分，避免过度惩罚
        if sentiment_ratio >= 0.5:
            return 0.6 + sentiment_ratio * 0.4  # 0.8 ~ 1.0
        else:
            return 0.4 + sentiment_ratio * 0.4  # 0.4 ~ 0.6
    
    def _calculate_context_awareness(self, text: str, metadata: dict) -> float:
        """计算上下文感知得分：与历史记忆的关联度"""
        if not self.store or not self.embedding_module:
            return 0.5
        
        try:
            # 获取当前文本的embedding
            current_embedding = self.embedding_module.embed_text([text])[0]
            
            # 搜索相似的历史记忆（限制数量）
            similar_memories = self.store.search_similar(
                query_vector=current_embedding,
                top_k=5,
                memory_type=None
            )
            
            if not similar_memories:
                return 0.5  # 无历史记忆，中性得分
            
            # 计算平均相似度
            similarities = []
            for memory in similar_memories:
                if hasattr(memory, 'score'):
                    similarities.append(memory.score)
                elif isinstance(memory, dict):
                    similarities.append(memory.get('score', 0))
            
            if not similarities:
                return 0.5
            
            avg_similarity = sum(similarities) / len(similarities)
            
            # 转换得分：
            # - 相似度过高(>0.9)可能是重复，扣分
            # - 适度相似(0.5-0.9)表示有上下文关联，加分
            # - 相似度过低(<0.3)表示全新内容，中性
            if avg_similarity > 0.9:
                return 0.4  # 可能重复
            elif avg_similarity > 0.7:
                return 0.9  # 强关联
            elif avg_similarity > 0.5:
                return 0.8  # 中度关联
            elif avg_similarity > 0.3:
                return 0.6  # 弱关联
            else:
                return 0.5  # 无关联（新内容）
                
        except Exception as e:
            logger.debug(f"Error calculating context awareness: {e}")
            return 0.5

    def _generate_feedback(
        self, 
        importance: float, 
        density: float, 
        relevance: float, 
        clarity: float,
        sentiment: float,
        context_awareness: float,
        level: QualityLevel
    ) -> tuple:
        reasons = []
        suggestions = []
        
        if importance < 0.5:
            reasons.append("Low importance score")
            suggestions.append("Add more specific keywords or context")
        
        if density < 0.4:
            reasons.append("Low information density")
            suggestions.append("Reduce filler words, add more specific details")
        
        if relevance < 0.5:
            reasons.append("Low relevance")
            suggestions.append("Add context or source information")
        
        if clarity < 0.6:
            reasons.append("Text clarity could be improved")
            suggestions.append("Break into shorter sentences, reduce repetition")
        
        if sentiment < 0.4:
            reasons.append("Negative sentiment detected")
            suggestions.append("Consider reframing in a more constructive way")
        
        if context_awareness < 0.4:
            reasons.append("Low context connection")
            suggestions.append("Link to related memories or add more context")
        elif context_awareness > 0.9:
            reasons.append("Possible duplicate of existing memory")
            suggestions.append("Check if this memory already exists")
        
        if level == QualityLevel.HIGH:
            reasons.append("High quality memory with good information density")
        
        return reasons, suggestions

    def _calculate_priority(self, overall: float, level: QualityLevel) -> int:
        if level == QualityLevel.HIGH:
            return 3
        elif level == QualityLevel.MEDIUM:
            return 2
        elif level == QualityLevel.LOW:
            return 1
        else:
            return 0

    def batch_evaluate(self, texts: List[str]) -> List[MemoryQuality]:
        return [self.evaluate(text) for text in texts]

    def filter_low_quality(self, items: List[dict]) -> List[dict]:
        filtered = []
        
        for item in items:
            text = item.get("text", "")
            quality = self.evaluate(text, item.get("metadata"))
            
            if quality.should_store:
                item["quality"] = quality
                filtered.append(item)
        
        return filtered

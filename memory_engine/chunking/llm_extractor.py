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


VALID_CATEGORIES = [
    "fact", "instruction", "event", "conversation", "knowledge",
    "decision", "problem", "solution", "preference", "reminder",
    "requirement", "goal", "progress", "resource", "tool",
    "performance", "security", "design", "testing", "communication",
    "data", "team", "other"
]

CATEGORY_DESCRIPTIONS = {
    "fact": "Factual statements, definitions, principles (事实定义类)",
    "instruction": "How-to guides, tutorials, procedures (操作指南类)",
    "event": "Events, meetings, activities, experiences (事件记录类)",
    "conversation": "Dialogues, chats, discussions (对话记录类)",
    "knowledge": "Learned insights, discoveries, summaries (知识发现类)",
    "decision": "Decisions made, choices selected (决策类)",
    "problem": "Errors, issues, bugs, failures (问题类)",
    "solution": "Solutions, fixes, workarounds (解决方案类)",
    "preference": "Preferences, likes, recommendations (偏好类)",
    "reminder": "Reminders, warnings, notes to remember (提醒类)",
    "requirement": "Requirements, needs, must-haves (需求类)",
    "goal": "Goals, targets, objectives, plans (目标类)",
    "progress": "Progress updates, status reports (进度类)",
    "resource": "Resources, links, references, documents (资源类)",
    "tool": "Tools, software, frameworks, plugins (工具类)",
    "performance": "Performance, speed, optimization (性能类)",
    "security": "Security, authentication, permissions (安全类)",
    "design": "Design, architecture, patterns (设计类)",
    "testing": "Testing, verification, validation (测试类)",
    "communication": "Communication, feedback, reports (沟通类)",
    "data": "Data, statistics, analysis, reports (数据类)",
    "team": "Team, members, collaboration (团队类)",
    "other": "Other categories not fitting above (其他)"
}

STRUCTURED_SUMMARY_PROMPT = """Analyze the following text and extract comprehensive structured information.

Text:
{text}

Please provide:
1. A concise summary (2-3 sentences max)
2. Main topic or subject
3. Relevant keywords (3-7 keywords)
4. Named entities mentioned (people, places, organizations, technical terms, etc.)
5. Sentiment (positive, negative, or neutral)
6. Category (one of: fact, instruction, event, conversation, knowledge, decision, problem, solution, preference, reminder, requirement, goal, progress, resource, tool, performance, security, design, testing, communication, data, team, other)
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

    CATEGORY_KEYWORDS = {
        "instruction": [
            "how to", "step", "guide", "tutorial", "walkthrough", "procedure",
            "方法", "步骤", "教程", "操作", "流程", "配置", "安装", "部署",
            "设置", "指南", "说明", "怎么做", "如何"
        ],
        "event": [
            "meeting", "event", "schedule", "appointment", "conference",
            "会议", "事件", "活动", "日程", "约会", "经历", "访问", "出行",
            "发生", "举行", "参加", "出席"
        ],
        "conversation": [
            "chat", "talk", "conversation", "dialogue", "discussion",
            "对话", "聊天", "交流", "讨论", "沟通", "协商", "对话记录"
        ],
        "knowledge": [
            "learned", "discovered", "found", "insight", "understanding",
            "学到", "发现", "了解到", "认识到", "总结", "归纳", "心得",
            "知识", "学习", "理解", "掌握", "原理", "概念"
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
            "回复", "回复", "通知"
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
        ],
        "fact": [
            "is", "are", "was", "were", "means", "defined as",
            "定义", "是指", "意思是", "本质", "原理", "特性",
            "事实", "实际上", "客观"
        ]
    }

    def _categorize(self, text: str) -> str:
        text_lower = text.lower()
        
        for category, keywords in self.CATEGORY_KEYWORDS.items():
            for keyword in keywords:
                if keyword in text_lower:
                    return category
        
        return "other"


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

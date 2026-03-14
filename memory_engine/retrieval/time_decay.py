import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class DecayCurve(Enum):
    EXPONENTIAL = "exponential"
    LINEAR = "linear"
    LOGARITHMIC = "logarithmic"
    STEP = "step"
    CUSTOM = "custom"


@dataclass
class DecayConfig:
    curve: DecayCurve = DecayCurve.EXPONENTIAL
    halflife: float = 30.0
    min_score: float = 0.1
    max_score: float = 1.0
    
    type_weights: Dict[str, float] = field(default_factory=lambda: {
        "core_rule": 2.0,
        "knowledge": 1.5,
        "instruction": 1.3,
        "fact": 1.2,
        "event": 1.0,
        "daily_log": 0.8,
        "conversation": 0.7,
        "other": 0.5
    })
    
    hit_count_weight: float = 0.1
    importance_weight: float = 0.2
    
    step_thresholds: Dict[int, float] = field(default_factory=lambda: {
        7: 0.9,
        30: 0.7,
        90: 0.5,
        180: 0.3,
        365: 0.2
    })
    
    custom_func: Optional[Callable] = None


class TimeDecayCalculator:
    def __init__(self, config: DecayConfig = None):
        self.config = config or DecayConfig()

    def calculate(
        self,
        days_old: float,
        category: str = "other",
        hit_count: int = 0,
        importance_score: float = 0.5,
        weight: int = 1
    ) -> float:
        base_decay = self._calculate_base_decay(days_old)
        
        type_multiplier = self.config.type_weights.get(category, 1.0)
        
        hit_bonus = min(0.5, hit_count * self.config.hit_count_weight)
        
        importance_bonus = importance_score * self.config.importance_weight
        
        weight_multiplier = min(2.0, 1.0 + (weight - 1) * 0.1) if weight > 1 else max(0.5, weight * 0.5)
        
        final_score = base_decay * type_multiplier * weight_multiplier
        final_score += hit_bonus + importance_bonus
        
        return max(self.config.min_score, min(self.config.max_score, final_score))

    def _calculate_base_decay(self, days_old: float) -> float:
        if days_old <= 0:
            return self.config.max_score
        
        if self.config.curve == DecayCurve.EXPONENTIAL:
            return self._exponential_decay(days_old)
        elif self.config.curve == DecayCurve.LINEAR:
            return self._linear_decay(days_old)
        elif self.config.curve == DecayCurve.LOGARITHMIC:
            return self._logarithmic_decay(days_old)
        elif self.config.curve == DecayCurve.STEP:
            return self._step_decay(days_old)
        elif self.config.curve == DecayCurve.CUSTOM and self.config.custom_func:
            return self.config.custom_func(days_old)
        else:
            return self._exponential_decay(days_old)

    def _exponential_decay(self, days_old: float) -> float:
        return math.exp(-days_old * math.log(2) / self.config.halflife)

    def _linear_decay(self, days_old: float) -> float:
        max_days = self.config.halflife * 3
        score = 1.0 - (days_old / max_days)
        return max(0.0, score)

    def _logarithmic_decay(self, days_old: float) -> float:
        if days_old < 1:
            return 1.0
        return 1.0 / (1.0 + math.log(1 + days_old / self.config.halflife))

    def _step_decay(self, days_old: float) -> float:
        for threshold_days, score in sorted(self.config.step_thresholds.items()):
            if days_old <= threshold_days:
                return score
        return self.config.min_score

    def batch_calculate(
        self,
        items: List[Dict],
        date_field: str = "date",
        type_field: str = "type",
        hit_count_field: str = "hit_count",
        importance_field: str = "importance_score",
        weight_field: str = "weight"
    ) -> List[float]:
        now = datetime.now(timezone.utc)
        scores = []
        
        for item in items:
            date_str = item.get(date_field, "")
            days_old = self._calculate_days_old(date_str, now)
            
            score = self.calculate(
                days_old=days_old,
                category=item.get(type_field, "other"),
                hit_count=item.get(hit_count_field, 0),
                importance_score=item.get(importance_field, 0.5),
                weight=item.get(weight_field, 1)
            )
            scores.append(score)
        
        return scores

    def _calculate_days_old(self, date_str: str, now: datetime) -> float:
        if not date_str:
            return 0.0
        
        try:
            if len(date_str) == 10:
                memory_date = datetime.strptime(date_str, "%Y-%m-%d").replace(tzinfo=timezone.utc)
            else:
                cleaned = date_str.replace("Z", "").replace("+00:00", "")
                memory_date = datetime.fromisoformat(cleaned)
                if memory_date.tzinfo is None:
                    memory_date = memory_date.replace(tzinfo=timezone.utc)
            
            delta = now - memory_date
            return max(0.0, delta.total_seconds() / 86400.0)
        except Exception:
            return 0.0


class AdaptiveDecayCalculator(TimeDecayCalculator):
    def __init__(self, config: DecayConfig = None):
        super().__init__(config)
        self._access_history: Dict[str, List[float]] = {}
        self._type_access_stats: Dict[str, Dict] = {}

    def record_access(self, memory_id: str, category: str):
        now = datetime.now(timezone.utc).timestamp()
        
        if memory_id not in self._access_history:
            self._access_history[memory_id] = []
        self._access_history[memory_id].append(now)
        
        if category not in self._type_access_stats:
            self._type_access_stats[category] = {"count": 0, "last_access": now}
        self._type_access_stats[category]["count"] += 1
        self._type_access_stats[category]["last_access"] = now

    def calculate_with_history(
        self,
        memory_id: str,
        days_old: float,
        category: str = "other",
        hit_count: int = 0,
        importance_score: float = 0.5,
        weight: int = 1
    ) -> float:
        base_score = self.calculate(days_old, category, hit_count, importance_score, weight)
        
        access_bonus = self._calculate_access_frequency_bonus(memory_id)
        
        type_bonus = self._calculate_type_relevance_bonus(category)
        
        final_score = base_score * (1.0 + access_bonus) * (1.0 + type_bonus)
        
        return max(self.config.min_score, min(self.config.max_score, final_score))

    def _calculate_access_frequency_bonus(self, memory_id: str) -> float:
        if memory_id not in self._access_history:
            return 0.0
        
        history = self._access_history[memory_id]
        now = datetime.now(timezone.utc).timestamp()
        
        recent_accesses = sum(1 for t in history if now - t < 7 * 86400)
        
        return min(0.3, recent_accesses * 0.05)

    def _calculate_type_relevance_bonus(self, category: str) -> float:
        if category not in self._type_access_stats:
            return 0.0
        
        stats = self._type_access_stats[category]
        now = datetime.now(timezone.utc).timestamp()
        
        hours_since_last = (now - stats["last_access"]) / 3600
        
        if hours_since_last < 24:
            return 0.1
        elif hours_since_last < 72:
            return 0.05
        
        return 0.0

    def get_type_stats(self) -> Dict[str, Dict]:
        return self._type_access_stats.copy()

    def clear_history(self):
        self._access_history.clear()
        self._type_access_stats.clear()


class DecayConfigBuilder:
    @staticmethod
    def for_recent_focus() -> DecayConfig:
        return DecayConfig(
            curve=DecayCurve.EXPONENTIAL,
            halflife=7.0,
            min_score=0.05,
            type_weights={
                "core_rule": 1.5,
                "event": 1.3,
                "daily_log": 1.0,
                "other": 0.7
            }
        )

    @staticmethod
    def for_long_term() -> DecayConfig:
        return DecayConfig(
            curve=DecayCurve.LOGARITHMIC,
            halflife=90.0,
            min_score=0.3,
            type_weights={
                "core_rule": 2.5,
                "knowledge": 2.0,
                "instruction": 1.8,
                "fact": 1.5,
                "event": 1.0,
                "other": 0.8
            }
        )

    @staticmethod
    def for_balanced() -> DecayConfig:
        return DecayConfig(
            curve=DecayCurve.EXPONENTIAL,
            halflife=30.0,
            min_score=0.1,
            type_weights={
                "core_rule": 2.0,
                "knowledge": 1.5,
                "instruction": 1.3,
                "fact": 1.2,
                "event": 1.0,
                "daily_log": 0.8,
                "other": 0.5
            }
        )

    @staticmethod
    def for_step_function() -> DecayConfig:
        return DecayConfig(
            curve=DecayCurve.STEP,
            step_thresholds={
                1: 1.0,
                3: 0.9,
                7: 0.8,
                14: 0.7,
                30: 0.6,
                60: 0.5,
                90: 0.4,
                180: 0.3,
                365: 0.2
            }
        )

    @staticmethod
    def from_dict(config_dict: Dict) -> DecayConfig:
        curve_str = config_dict.get("curve", "exponential")
        curve = DecayCurve(curve_str) if curve_str in [e.value for e in DecayCurve] else DecayCurve.EXPONENTIAL
        
        return DecayConfig(
            curve=curve,
            halflife=config_dict.get("halflife", 30.0),
            min_score=config_dict.get("min_score", 0.1),
            max_score=config_dict.get("max_score", 1.0),
            type_weights=config_dict.get("type_weights", DecayConfig().type_weights),
            hit_count_weight=config_dict.get("hit_count_weight", 0.1),
            importance_weight=config_dict.get("importance_weight", 0.2),
            step_thresholds=config_dict.get("step_thresholds", DecayConfig().step_thresholds)
        )

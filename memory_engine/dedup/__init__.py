import hashlib
import json
import logging
import math
import os
import threading
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Set, Tuple

logger = logging.getLogger(__name__)


@dataclass
class DedupResult:
    is_duplicate: bool
    similarity: float
    stage: str  # 在哪个阶段判定为重复
    similar_memory_id: Optional[str] = None
    similar_text: Optional[str] = None


class SimHash:
    """局部敏感哈希，用于快速预过滤"""
    
    def __init__(self, hash_bits: int = 64):
        self.hash_bits = hash_bits

    def compute(self, text: str) -> int:
        """计算文本的SimHash指纹"""
        tokens = self._tokenize(text)
        if not tokens:
            return 0
        
        v = [0] * self.hash_bits
        
        for token in tokens:
            token_hash = int(hashlib.md5(token.encode()).hexdigest(), 16)
            for i in range(self.hash_bits):
                if token_hash & (1 << i):
                    v[i] += 1
                else:
                    v[i] -= 1
        
        fingerprint = 0
        for i in range(self.hash_bits):
            if v[i] > 0:
                fingerprint |= (1 << i)
        
        return fingerprint

    def _tokenize(self, text: str) -> List[str]:
        """2-gram分词"""
        words = text.lower().split()
        return [''.join(words[i:i+2]) for i in range(len(words) - 1)]

    def hamming_distance(self, hash1: int, hash2: int) -> int:
        """计算海明距离"""
        xor = hash1 ^ hash2
        return bin(xor).count('1')

    def similarity(self, hash1: int, hash2: int) -> float:
        """基于海明距离的相似度"""
        distance = self.hamming_distance(hash1, hash2)
        return 1.0 - (distance / self.hash_bits)


class MinHash:
    """最小哈希，用于精确比较"""
    
    def __init__(self, num_perm: int = 128):
        self.num_perm = num_perm
        self._prime = 2**61 - 1
        self._coeff_a = [self._random_int() for _ in range(num_perm)]
        self._coeff_b = [self._random_int() for _ in range(num_perm)]

    def _random_int(self) -> int:
        import random
        return random.randint(1, self._prime - 1)

    def compute(self, text: str) -> List[int]:
        """计算MinHash签名"""
        shingles = self._shingle(text)
        if not shingles:
            return [self._prime] * self.num_perm
        
        signature = [self._prime] * self.num_perm
        
        for shingle in shingles:
            shingle_hash = hash(shingle) & 0x7FFFFFFFFFFFFFFF
            for i in range(self.num_perm):
                h = (self._coeff_a[i] * shingle_hash + self._coeff_b[i]) % self._prime
                if h < signature[i]:
                    signature[i] = h
        
        return signature

    def _shingle(self, text: str, k: int = 3) -> Set[str]:
        """k-gram分词"""
        words = text.lower().split()
        if len(words) < k:
            return {' '.join(words)}
        return {' '.join(words[i:i+k]) for i in range(len(words) - k + 1)}

    def jaccard_similarity(self, sig1: List[int], sig2: List[int]) -> float:
        """估计Jaccard相似度"""
        if len(sig1) != len(sig2):
            return 0.0
        
        matches = sum(1 for a, b in zip(sig1, sig2) if a == b)
        return matches / len(sig1)


class ThreeStageDeduplicator:
    """
    三阶段去重器
    
    阶段1: SimHash + 海明距离（快速预过滤）
    阶段2: MinHash精确比较
    阶段3: Vector余弦相似度
    """
    
    def __init__(self, config: dict = None):
        config = config or {}
        
        # 阶段1: SimHash
        self.simhash = SimHash(hash_bits=config.get("simhash_bits", 64))
        self.simhash_threshold = config.get("simhash_threshold", 0.85)  # 海明距离≤9
        self.simhash_max_distance = config.get("simhash_max_distance", 9)
        
        # 阶段2: MinHash
        self.minhash = MinHash(num_perm=config.get("minhash_permutations", 128))
        self.minhash_threshold = config.get("minhash_threshold", 0.7)
        
        # 阶段3: Vector
        self.vector_threshold = config.get("vector_threshold", 0.95)
        
        # 候选集限制
        self.max_candidates = config.get("max_candidates", 50)
        
        # 数据存储
        self._text_store: Dict[str, str] = {}
        self._simhash_store: Dict[str, int] = {}
        self._minhash_store: Dict[str, List[int]] = {}
        self._vector_store: Dict[str, List[float]] = {}
        
        # 持久化配置
        self.persist_path = config.get("persist_path")
        self._lock = threading.RLock()
        
        # 加载已有数据
        if self.persist_path:
            self._load()

    def add(self, item_id: str, text: str, vector: List[float] = None):
        """添加新的记忆到去重索引"""
        with self._lock:
            self._text_store[item_id] = text
            
            # 计算并存储SimHash
            simhash_val = self.simhash.compute(text)
            self._simhash_store[item_id] = simhash_val
            
            # 计算并存储MinHash
            minhash_sig = self.minhash.compute(text)
            self._minhash_store[item_id] = minhash_sig
            
            # 存储Vector（如果有）
            if vector:
                self._vector_store[item_id] = vector
            
            # 持久化
            if self.persist_path:
                self._save()

    def check_duplicate(self, text: str, vector: List[float] = None) -> DedupResult:
        """
        三阶段去重检测
        
        阶段1: SimHash快速预过滤
        阶段2: MinHash精确比较
        阶段3: Vector余弦相似度
        """
        with self._lock:
            if not self._text_store:
                return DedupResult(is_duplicate=False, similarity=0.0, stage="none")
            
            # ========== 阶段1: SimHash快速预过滤 ==========
            simhash_val = self.simhash.compute(text)
            
            # 快速筛选候选（海明距离≤阈值）
            candidates = []
            for item_id, stored_hash in self._simhash_store.items():
                distance = self.simhash.hamming_distance(simhash_val, stored_hash)
                if distance <= self.simhash_max_distance:
                    similarity = 1.0 - (distance / self.simhash.hash_bits)
                    candidates.append((item_id, similarity, distance))
            
            # 按相似度排序，取前N个
            candidates.sort(key=lambda x: x[1], reverse=True)
            candidates = candidates[:self.max_candidates]
            
            if not candidates:
                # 快速排除：没有相似候选
                return DedupResult(is_duplicate=False, similarity=0.0, stage="simhash")
            
            # ========== 阶段2: MinHash精确比较 ==========
            minhash_sig = self.minhash.compute(text)
            
            best_minhash_sim = 0.0
            best_candidate_id = None
            
            for item_id, simhash_sim, _ in candidates:
                stored_sig = self._minhash_store.get(item_id)
                if stored_sig:
                    minhash_sim = self.minhash.jaccard_similarity(minhash_sig, stored_sig)
                    if minhash_sim > best_minhash_sim:
                        best_minhash_sim = minhash_sim
                        best_candidate_id = item_id
            
            # MinHash判定为重复
            if best_minhash_sim >= self.minhash_threshold:
                return DedupResult(
                    is_duplicate=True,
                    similarity=best_minhash_sim,
                    stage="minhash",
                    similar_memory_id=best_candidate_id,
                    similar_text=self._text_store.get(best_candidate_id, "")
                )
            
            # ========== 阶段3: Vector余弦相似度 ==========
            if vector and best_candidate_id:
                best_vector_sim = 0.0
                best_vector_id = None
                
                # 只对MinHash相似度较高的候选进行Vector比较
                high_confidence_candidates = [
                    (item_id, sim) for item_id, sim, _ in candidates
                    if sim >= self.simhash_threshold
                ]
                
                for item_id, _ in high_confidence_candidates[:10]:  # 限制Vector比较数量
                    stored_vector = self._vector_store.get(item_id)
                    if stored_vector:
                        vector_sim = self._cosine_similarity(vector, stored_vector)
                        if vector_sim > best_vector_sim:
                            best_vector_sim = vector_sim
                            best_vector_id = item_id
                
                # Vector判定为重复
                if best_vector_sim >= self.vector_threshold:
                    return DedupResult(
                        is_duplicate=True,
                        similarity=best_vector_sim,
                        stage="vector",
                        similar_memory_id=best_vector_id,
                        similar_text=self._text_store.get(best_vector_id, "")
                    )
            
            # 未判定为重复，返回最相似的候选信息
            best_sim = best_minhash_sim if best_minhash_sim > 0 else (
                candidates[0][1] if candidates else 0.0
            )
            best_id = best_candidate_id or (candidates[0][0] if candidates else None)
            
            return DedupResult(
                is_duplicate=False,
                similarity=best_sim,
                stage="all_passed",
                similar_memory_id=best_id,
                similar_text=self._text_store.get(best_id, "") if best_id else None
            )

    def _cosine_similarity(self, vec1: List[float], vec2: List[float]) -> float:
        """计算余弦相似度"""
        if len(vec1) != len(vec2):
            return 0.0
        
        dot_product = sum(a * b for a, b in zip(vec1, vec2))
        norm1 = math.sqrt(sum(a * a for a in vec1))
        norm2 = math.sqrt(sum(b * b for b in vec2))
        
        if norm1 == 0 or norm2 == 0:
            return 0.0
        
        return dot_product / (norm1 * norm2)

    def remove(self, item_id: str):
        """移除指定记忆"""
        with self._lock:
            self._text_store.pop(item_id, None)
            self._simhash_store.pop(item_id, None)
            self._minhash_store.pop(item_id, None)
            self._vector_store.pop(item_id, None)
            
            if self.persist_path:
                self._save()

    def clear(self):
        """清空所有数据"""
        with self._lock:
            self._text_store.clear()
            self._simhash_store.clear()
            self._minhash_store.clear()
            self._vector_store.clear()
            
            if self.persist_path:
                self._save()

    def _save(self):
        """持久化到磁盘"""
        try:
            data = {
                "text_store": self._text_store,
                "simhash_store": {k: v for k, v in self._simhash_store.items()},
                "minhash_store": {k: v for k, v in self._minhash_store.items()},
                "vector_store": {k: v for k, v in self._vector_store.items()}
            }
            
            # 确保目录存在
            os.makedirs(os.path.dirname(self.persist_path), exist_ok=True)
            
            with open(self.persist_path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False)
                
        except Exception as e:
            logger.error(f"Failed to save dedup data: {e}")

    def _load(self):
        """从磁盘加载"""
        if not os.path.exists(self.persist_path):
            return
        
        try:
            with open(self.persist_path, 'r', encoding='utf-8') as f:
                data = json.load(f)
            
            self._text_store = data.get("text_store", {})
            self._simhash_store = {k: int(v) for k, v in data.get("simhash_store", {}).items()}
            self._minhash_store = {k: list(v) for k, v in data.get("minhash_store", {}).items()}
            self._vector_store = {k: list(v) for k, v in data.get("vector_store", {}).items()}
            
            logger.info(f"Loaded {len(self._text_store)} items from dedup cache")
            
        except Exception as e:
            logger.error(f"Failed to load dedup data: {e}")

    def get_stats(self) -> dict:
        """获取统计信息"""
        with self._lock:
            return {
                "total_items": len(self._text_store),
                "simhash_items": len(self._simhash_store),
                "minhash_items": len(self._minhash_store),
                "vector_items": len(self._vector_store),
                "persist_path": self.persist_path
            }


# 向后兼容：保留旧类名
HybridDeduplicator = ThreeStageDeduplicator

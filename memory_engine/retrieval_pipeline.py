import logging
import math
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from .config import get_config
from .lancedb_store import OpenClawMemory
from .reranker import Reranker
from .semantic_memory import SemanticMemory
from .llm_client import LLMClient

logger = logging.getLogger(__name__)


class RetrievalPipeline:
    def __init__(self):
        config = get_config()
        self.semantic_memory = SemanticMemory()
        self.reranker = Reranker()
        self.llm_client = LLMClient()
        self.time_decay_halflife = config.get("time_decay_halflife", 30)

    def search(
        self,
        query: str,
        top_k: int = 10,
        final_k: int = 3,
        query_type: str = "hybrid",
        category: Optional[str] = None,
        apply_time_decay: bool = True,
        apply_rerank: bool = True,
        merge_with_llm: bool = False
    ) -> List[Dict[str, Any]]:
        results = self.semantic_memory.search(
            query=query,
            top_k=top_k,
            query_type=query_type,
            category=category
        )
        
        if not results:
            return []
        
        if apply_time_decay:
            results = self._apply_time_decay(results)
        
        if apply_rerank and self.reranker.is_available():
            results = self._apply_rerank(query, results)
        
        results.sort(key=lambda x: x.get("final_score", 0), reverse=True)
        
        top_results = results[:final_k]
        
        for r in top_results:
            memory_id = r.get("id")
            if memory_id:
                self.semantic_memory.update_hit_count(memory_id)
        
        if merge_with_llm and self.llm_client.is_available() and len(top_results) > 1:
            merged_result = self._merge_with_llm(query, top_results)
            if merged_result:
                top_results = merged_result
        
        return top_results

    def _merge_with_llm(self, query: str, results: List[Dict[str, Any]]) -> Optional[List[Dict[str, Any]]]:
        if not results or len(results) < 2:
            return results
        
        try:
            context_parts = []
            for i, r in enumerate(results):
                text = r.get("text", "")
                category = r.get("category", "unknown")
                date = r.get("date", "")
                context_parts.append(f"[{i+1}] Category: {category}, Date: {date}\n{text}")
            
            context = "\n\n".join(context_parts)
            
            prompt = f"""Based on the following search results for query "{query}", please:
1. Identify and merge duplicate or highly similar information
2. Preserve all unique information from each result
3. Establish causal relationships if any exist
4. Output a consolidated summary

IMPORTANT: Only use information from the provided results. Do not add any information not present in the results.

Search Results:
{context}

Please output in the following JSON format:
{{
  "merged_summary": "consolidated summary text",
  "sources_used": [1, 2, 3],
  "duplicates_found": [[1, 2], [3, 4]],
  "causal_relations": ["A leads to B"]
}}"""

            response = self.llm_client.client.chat.completions.create(
                model=self.llm_client.model,
                messages=[
                    {"role": "system", "content": "You are a memory consolidation assistant. Merge and summarize information accurately without adding new information."},
                    {"role": "user", "content": prompt}
                ],
                temperature=0.1
            )
            
            content = response.choices[0].message.content.strip()
            
            try:
                if content.startswith("```"):
                    content = content.split("```")[1]
                    if content.startswith("json"):
                        content = content[4:]
                merged_data = eval(content) if "{" in content else {}
            except Exception:
                merged_data = {"merged_summary": content}
            
            if merged_data.get("merged_summary"):
                merged_item = {
                    "id": "merged",
                    "text": merged_data["merged_summary"],
                    "category": "merged",
                    "final_score": max(r.get("final_score", 0) for r in results),
                    "source_ids": [r.get("id") for r in results],
                    "sources_used": merged_data.get("sources_used", []),
                    "duplicates_found": merged_data.get("duplicates_found", []),
                    "causal_relations": merged_data.get("causal_relations", []),
                    "is_merged": True
                }
                return [merged_item] + results
            
        except Exception as e:
            logger.warning(f"LLM merge failed: {e}")
        
        return results

    def _apply_time_decay(self, results: List[OpenClawMemory]) -> List[Dict[str, Any]]:
        now = datetime.now(timezone.utc)
        processed = []
        
        for memory in results:
            memory_dict = memory.model_dump()
            weight = memory_dict.get("weight", 1)
            
            if weight >= 10:
                memory_dict["time_decay_score"] = 1.0
                memory_dict["final_score"] = 1.0
                processed.append(memory_dict)
                continue
            
            date_str = memory_dict.get("date", "")
            memory_date = self._parse_date(date_str)
            if memory_date:
                days_old = (now - memory_date).days
                decay = math.exp(-days_old * math.log(2) / self.time_decay_halflife)
            else:
                decay = 1.0
            
            memory_dict["time_decay_score"] = decay
            memory_dict["final_score"] = decay
            processed.append(memory_dict)
        
        return processed

    def _parse_date(self, date_str: str) -> Optional[datetime]:
        if not date_str:
            return None
        
        date_str = str(date_str).strip()
        
        date_formats = [
            "%Y-%m-%d",
            "%Y/%m/%d",
            "%Y.%m.%d",
            "%d-%m-%Y",
            "%d/%m/%Y",
            "%Y-%m-%dT%H:%M:%S",
            "%Y-%m-%dT%H:%M:%SZ",
            "%Y-%m-%dT%H:%M:%S.%f",
            "%Y-%m-%dT%H:%M:%S.%fZ",
            "%Y-%m-%d %H:%M:%S",
            "%Y/%m/%d %H:%M:%S",
        ]
        
        for fmt in date_formats:
            try:
                parsed = datetime.strptime(date_str, fmt)
                if parsed.tzinfo is None:
                    parsed = parsed.replace(tzinfo=timezone.utc)
                return parsed
            except ValueError:
                continue
        
        try:
            cleaned = date_str.replace("Z", "+00:00")
            if "+" in cleaned and cleaned.count("+") == 1:
                cleaned = cleaned.replace("+", "T", 1) if "T" not in cleaned else cleaned
            return datetime.fromisoformat(cleaned)
        except ValueError:
            pass
        
        import re
        match = re.match(r"(\d{4})[-/](\d{1,2})[-/](\d{1,2})", date_str)
        if match:
            try:
                year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
                return datetime(year, month, day, tzinfo=timezone.utc)
            except ValueError:
                pass
        
        logger.debug(f"Failed to parse date: {date_str}")
        return None

    def _apply_rerank(self, query: str, results: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        if not results:
            return results
        
        texts = [r.get("text", "") for r in results]
        rerank_scores = self.reranker.rerank(query, texts)
        
        for i, r in enumerate(results):
            if i < len(rerank_scores):
                r["rerank_score"] = rerank_scores[i]
                decay = r.get("time_decay_score", 1.0)
                r["final_score"] = 0.6 * rerank_scores[i] + 0.4 * decay
        
        return results

    def search_by_category(
        self,
        query: str,
        category: str,
        top_k: int = 5
    ) -> List[Dict[str, Any]]:
        return self.search(
            query=query,
            top_k=top_k,
            final_k=top_k,
            category=category
        )

    def get_core_rules(self, limit: int = 10) -> List[Dict[str, Any]]:
        memories = self.semantic_memory.store.get_core_rules(limit=limit)
        return [m.model_dump() for m in memories]

    def search_by_date_range(
        self,
        start_date: str,
        end_date: str,
        limit: int = 50
    ) -> List[Dict[str, Any]]:
        memories = self.semantic_memory.store.search_by_date_range(
            start_date=start_date,
            end_date=end_date,
            limit=limit
        )
        return [m.model_dump() for m in memories]

import unittest
from memory_engine.metadata_schema import MemoryMetadata
from memory_engine.embedding import EmbeddingModule
from memory_engine.reranker import Reranker
from memory_engine.config import CONFIG, validate_config, check_environment
from memory_engine.lancedb_store import OpenClawMemory, VECTOR_DIM


class TestMemorySystem(unittest.TestCase):
    def test_metadata(self):
        meta = MemoryMetadata(type="event", date="2023-01-01T00:00:00Z", agent="test")
        self.assertEqual(meta.type, "event")
        self.assertEqual(meta.agent, "test")
        self.assertEqual(meta.hit_count, 0)
        
        meta_dict = meta.to_dict()
        self.assertIn("type", meta_dict)
        self.assertIn("date", meta_dict)
        self.assertEqual(meta_dict["type"], "event")

    def test_config_defaults(self):
        self.assertIn("embedding_model", CONFIG)
        self.assertIn("lancedb_path", CONFIG)
        self.assertIn("llm_model", CONFIG)
        self.assertIn("chunk", CONFIG)
        self.assertIn("time_decay_halflife", CONFIG)
        self.assertIn("promotion_hit_threshold", CONFIG)

    def test_config_validation(self):
        warnings = validate_config(CONFIG)
        self.assertIsInstance(warnings, list)

    def test_environment_check(self):
        issues = check_environment()
        self.assertIsInstance(issues, list)

    def test_embedding_fallback(self):
        emb = EmbeddingModule()
        res = emb.embed_text(["test"])
        self.assertEqual(len(res), 1)
        self.assertEqual(len(res[0]), VECTOR_DIM)

    def test_embedding_is_available(self):
        emb = EmbeddingModule()
        self.assertIsInstance(emb.is_available(), bool)

    def test_reranker_fallback(self):
        reranker = Reranker()
        res = reranker.rerank("query", ["doc1", "doc2"])
        self.assertEqual(len(res), 2)
        self.assertEqual(res, [1.0, 1.0])

    def test_reranker_is_available(self):
        reranker = Reranker()
        self.assertIsInstance(reranker.is_available(), bool)

    def test_reranker_empty_input(self):
        reranker = Reranker()
        res = reranker.rerank("query", [])
        self.assertEqual(res, [])

    def test_openclaw_memory_schema(self):
        memory = OpenClawMemory(
            id="test-id",
            vector=[0.0] * VECTOR_DIM,
            text="test memory",
            type="daily_log",
            date="2023-01-01",
            agent="openclaw"
        )
        self.assertEqual(memory.id, "test-id")
        self.assertEqual(memory.text, "test memory")
        self.assertEqual(memory.type, "daily_log")
        self.assertEqual(memory.hit_count, 0)
        self.assertEqual(memory.weight, 1)

    def test_openclaw_memory_optional_fields(self):
        memory = OpenClawMemory(
            id="test-id",
            vector=[0.0] * VECTOR_DIM,
            text="test memory",
            type="core_rule",
            date="2023-01-01",
            agent="openclaw",
            source_file="test.jsonl",
            hit_count=5,
            weight=10
        )
        self.assertEqual(memory.source_file, "test.jsonl")
        self.assertEqual(memory.hit_count, 5)
        self.assertEqual(memory.weight, 10)

    def test_openclaw_memory_model_dump(self):
        memory = OpenClawMemory(
            id="test-id",
            vector=[0.0] * VECTOR_DIM,
            text="test memory",
            type="daily_log",
            date="2023-01-01",
            agent="openclaw"
        )
        dumped = memory.model_dump()
        self.assertEqual(dumped["id"], "test-id")
        self.assertEqual(dumped["text"], "test memory")
        self.assertEqual(dumped["type"], "daily_log")
        self.assertIn("vector", dumped)

    def test_vector_dim_constant(self):
        self.assertEqual(VECTOR_DIM, 3072)


class TestRetrievalPipeline(unittest.TestCase):
    def test_time_decay_calculation(self):
        import math
        from datetime import datetime
        
        halflife = 30
        days_old = 30
        decay = math.exp(-days_old * math.log(2) / halflife)
        self.assertAlmostEqual(decay, 0.5, places=2)
        
        days_old = 60
        decay = math.exp(-days_old * math.log(2) / halflife)
        self.assertAlmostEqual(decay, 0.25, places=2)


if __name__ == "__main__":
    unittest.main()

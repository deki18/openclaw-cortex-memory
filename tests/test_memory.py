import unittest
from memory_engine.metadata_schema import MemoryMetadata
from memory_engine.embedding import EmbeddingModule
from memory_engine.reranker import Reranker
from memory_engine.config import CONFIG

class TestMemorySystem(unittest.TestCase):
    def test_metadata(self):
        meta = MemoryMetadata(type="event", date="2023-01-01T00:00:00Z", agent="test")
        self.assertEqual(meta.type, "event")
        self.assertEqual(meta.agent, "test")

    def test_config(self):
        self.assertIn("embedding_model", CONFIG)
        self.assertIn("vector_db_path", CONFIG)

    def test_embedding_fallback(self):
        emb = EmbeddingModule()
        # Should return fallback dimension if API key is dummy
        res = emb.embed_text(["test"])
        self.assertEqual(len(res), 1)
        self.assertEqual(len(res[0]), 3072)

    def test_reranker_fallback(self):
        reranker = Reranker()
        res = reranker.rerank("query", ["doc1", "doc2"])
        self.assertEqual(len(res), 2)
        self.assertEqual(res, [1.0, 1.0])

if __name__ == "__main__":
    unittest.main()

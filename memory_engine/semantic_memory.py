from .vector_store import VectorStore
from .bm25_store import BM25Store
from .embedding import EmbeddingModule
from .metadata_schema import MemoryMetadata
import uuid
from typing import List

class SemanticMemory:
    def __init__(self):
        self.vector_store = VectorStore()
        self.bm25_store = BM25Store()
        self.embedding_module = EmbeddingModule()

    def add_memory(self, text: str, metadata: MemoryMetadata) -> str:
        doc_id = str(uuid.uuid4())
        embedding = self.embedding_module.embed_text([text])[0]
        
        self.vector_store.add_documents(
            ids=[doc_id],
            embeddings=[embedding],
            documents=[text],
            metadatas=[metadata]
        )
        
        self.bm25_store.update(
            ids=[doc_id],
            documents=[text],
            metadatas=[metadata.to_dict()]
        )
        return doc_id

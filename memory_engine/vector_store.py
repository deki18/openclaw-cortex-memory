import chromadb
import os
from typing import List, Dict, Any
from .config import CONFIG
from .metadata_schema import MemoryMetadata

class VectorStore:
    def __init__(self):
        self.path = CONFIG.get("vector_db_path", "~/.openclaw/vector_store")
        os.makedirs(self.path, exist_ok=True)
        self.client = chromadb.PersistentClient(path=self.path)
        self.collection = self.client.get_or_create_collection(name="memory_collection")

    def add_documents(self, ids: List[str], embeddings: List[List[float]], documents: List[str], metadatas: List[MemoryMetadata]):
        meta_dicts = [m.to_dict() for m in metadatas]
        self.collection.add(
            ids=ids,
            embeddings=embeddings,
            documents=documents,
            metadatas=meta_dicts
        )

    def query(self, query_embeddings: List[List[float]], n_results: int = 20) -> Dict[str, Any]:
        try:
            return self.collection.query(
                query_embeddings=query_embeddings,
                n_results=n_results
            )
        except Exception as e:
            print(f"Vector store query error: {e}")
            return {"ids": [], "documents": [], "metadatas": [], "distances": []}

    def update_metadatas(self, ids: List[str], metadatas: List[Dict[str, Any]]):
        if not ids:
            return
        self.collection.update(ids=ids, metadatas=metadatas)

    def get_all(self, limit: int = 10000) -> Dict[str, Any]:
        try:
            return self.collection.get(limit=limit)
        except Exception as e:
            print(f"Vector store get error: {e}")
            return {"ids": [], "documents": [], "metadatas": []}

    def delete(self, ids: List[str]):
        self.collection.delete(ids=ids)

    def rebuild(self):
        self.client.delete_collection("memory_collection")
        self.collection = self.client.create_collection("memory_collection")

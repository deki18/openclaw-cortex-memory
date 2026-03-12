from rank_bm25 import BM25Okapi
from typing import List, Dict, Any
import json
import os

class BM25Store:
    def __init__(self, store_path="~/.openclaw/bm25_store.json"):
        self.store_path = os.path.expanduser(store_path)
        self.documents = []
        self.ids = []
        self.metadatas = []
        self.bm25 = None
        self._load()

    def _load(self):
        if os.path.exists(self.store_path):
            try:
                with open(self.store_path, "r") as f:
                    data = json.load(f)
                self.documents = data.get("documents", [])
                self.ids = data.get("ids", [])
                self.metadatas = data.get("metadatas", [])
                self.build_index()
            except Exception as e:
                print(f"Failed to load BM25 store: {e}")

    def _save(self):
        os.makedirs(os.path.dirname(self.store_path), exist_ok=True)
        with open(self.store_path, "w") as f:
            json.dump({
                "documents": self.documents,
                "ids": self.ids,
                "metadatas": self.metadatas
            }, f)

    def build_index(self):
        tokenized_corpus = [doc.split(" ") for doc in self.documents]
        if tokenized_corpus:
            self.bm25 = BM25Okapi(tokenized_corpus)
        else:
            self.bm25 = None

    def search(self, query: str, top_k: int = 20) -> List[Dict[str, Any]]:
        if not self.bm25:
            return []
            
        tokenized_query = query.split(" ")
        scores = self.bm25.get_scores(tokenized_query)
        
        # Sort by score
        scored_docs = sorted(zip(scores, self.ids, self.documents, self.metadatas), key=lambda x: x[0], reverse=True)
        
        results = []
        for score, doc_id, doc, meta in scored_docs[:top_k]:
            if score > 0:
                results.append({
                    "id": doc_id,
                    "document": doc,
                    "metadata": meta,
                    "score": score
                })
        return results

    def update(self, ids: List[str], documents: List[str], metadatas: List[Dict]):
        # Simple update: append and rebuild
        self.ids.extend(ids)
        self.documents.extend(documents)
        self.metadatas.extend(metadatas)
        self.build_index()
        self._save()

    def update_metadatas(self, ids: List[str], metadatas: List[Dict]):
        if not ids:
            return
        id_to_meta = {i: m for i, m in zip(ids, metadatas)}
        updated = False
        for idx, doc_id in enumerate(self.ids):
            if doc_id in id_to_meta:
                self.metadatas[idx] = id_to_meta[doc_id]
                updated = True
        if updated:
            self._save()

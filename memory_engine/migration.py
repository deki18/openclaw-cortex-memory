import logging
import os
from typing import List, Dict, Any

logger = logging.getLogger(__name__)


def migrate_from_chromadb(
    chromadb_path: str,
    lancedb_store,
    batch_size: int = 100
) -> int:
    """
    Migrate data from legacy ChromaDB to LanceDB.
    
    Args:
        chromadb_path: Path to the old ChromaDB database
        lancedb_store: LanceDBStore instance
        batch_size: Number of records to process per batch
    
    Returns:
        Number of records migrated
    """
    try:
        import chromadb
    except ImportError:
        logger.error("chromadb is not installed. Cannot migrate.")
        return 0
    
    try:
        from .lancedb_store import OpenClawMemory, VECTOR_DIM
    except ImportError:
        logger.error("LanceDB store not available")
        return 0
    
    if not os.path.exists(chromadb_path):
        logger.warning(f"ChromaDB path not found: {chromadb_path}")
        return 0
    
    try:
        client = chromadb.PersistentClient(path=chromadb_path)
        collections = client.list_collections()
        
        if not collections:
            logger.info("No collections found in ChromaDB")
            return 0
        
        total_migrated = 0
        memories_batch: List[OpenClawMemory] = []
        
        for collection in collections:
            logger.info(f"Migrating collection: {collection.name}")
            
            result = collection.get(include=["embeddings", "documents", "metadatas"])
            ids = result.get("ids", [])
            embeddings = result.get("embeddings", [])
            documents = result.get("documents", [])
            metadatas = result.get("metadatas", [])
            
            for i, doc_id in enumerate(ids):
                if not documents[i]:
                    continue
                
                embedding = embeddings[i] if i < len(embeddings) else [0.0] * VECTOR_DIM
                if not embedding or len(embedding) != VECTOR_DIM:
                    embedding = [0.0] * VECTOR_DIM
                
                meta = metadatas[i] if i < len(metadatas) and metadatas[i] else {}
                
                memory = OpenClawMemory(
                    id=doc_id,
                    vector=embedding,
                    text=documents[i],
                    type=meta.get("type", "daily_log"),
                    date=meta.get("date", "2023-01-01"),
                    agent=meta.get("agent", "openclaw"),
                    source_file=meta.get("source_file"),
                    hit_count=int(meta.get("hit_count", 0)),
                    weight=int(meta.get("weight", 1))
                )
                
                memories_batch.append(memory)
                
                if len(memories_batch) >= batch_size:
                    lancedb_store.add_memories(memories_batch)
                    total_migrated += len(memories_batch)
                    memories_batch = []
        
        if memories_batch:
            lancedb_store.add_memories(memories_batch)
            total_migrated += len(memories_batch)
        
        logger.info(f"Migration complete. Total records: {total_migrated}")
        return total_migrated
        
    except Exception as e:
        logger.error(f"Migration failed: {e}")
        return 0

import asyncio
import logging
import queue
import threading
import time
import uuid
from collections import defaultdict
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Dict, List, Optional

logger = logging.getLogger(__name__)


class WriteStatus(Enum):
    PENDING = "pending"
    PROCESSING = "processing"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass
class WriteTask:
    id: str
    text: str
    metadata: dict
    vector: Optional[List[float]] = None
    status: WriteStatus = WriteStatus.PENDING
    retries: int = 0
    max_retries: int = 3
    created_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None
    error: Optional[str] = None
    result: Optional[Any] = None


@dataclass
class BatchResult:
    total: int
    successful: int
    failed: int
    task_ids: List[str]
    errors: List[Dict[str, str]]


class WriteBuffer:
    def __init__(self, max_size: int = 100, flush_interval: float = 2.0):
        self.max_size = max_size
        self.flush_interval = flush_interval
        self._buffer: List[WriteTask] = []
        self._lock = threading.RLock()
        self._last_flush = time.time()

    def add(self, task: WriteTask) -> bool:
        with self._lock:
            self._buffer.append(task)
            return len(self._buffer) >= self.max_size

    def should_flush(self) -> bool:
        with self._lock:
            if len(self._buffer) >= self.max_size:
                return True
            if self._buffer and (time.time() - self._last_flush) >= self.flush_interval:
                return True
            return False

    def get_batch(self) -> List[WriteTask]:
        with self._lock:
            batch = self._buffer.copy()
            self._buffer.clear()
            self._last_flush = time.time()
            return batch

    def size(self) -> int:
        with self._lock:
            return len(self._buffer)

    def clear(self):
        with self._lock:
            self._buffer.clear()


class AsyncWriteQueue:
    def __init__(self, max_workers: int = 2, batch_size: int = 20):
        self.max_workers = max_workers
        self.batch_size = batch_size
        self._queue: queue.Queue = queue.Queue()
        self._results: Dict[str, WriteTask] = {}
        self._callbacks: Dict[str, Callable] = {}
        self._workers: List[threading.Thread] = []
        self._running = False
        self._lock = threading.RLock()
        self._processor: Optional[Callable] = None

    def set_processor(self, processor: Callable):
        self._processor = processor

    def start(self):
        if self._running:
            return
        
        self._running = True
        for i in range(self.max_workers):
            worker = threading.Thread(target=self._worker_loop, daemon=True, name=f"write-worker-{i}")
            worker.start()
            self._workers.append(worker)
        
        logger.info(f"Started {self.max_workers} write workers")

    def stop(self, timeout: float = 10.0):
        self._running = False
        
        for _ in self._workers:
            self._queue.put(None)
        
        for worker in self._workers:
            worker.join(timeout=timeout)
        
        self._workers.clear()
        logger.info("Write queue stopped")

    def submit(self, text: str, metadata: dict, callback: Callable = None) -> str:
        task_id = str(uuid.uuid4())
        task = WriteTask(
            id=task_id,
            text=text,
            metadata=metadata
        )
        
        with self._lock:
            self._results[task_id] = task
            if callback:
                self._callbacks[task_id] = callback
        
        self._queue.put(task)
        return task_id

    def submit_batch(self, items: List[Dict[str, Any]]) -> List[str]:
        task_ids = []
        for item in items:
            task_id = self.submit(
                text=item.get("text", ""),
                metadata=item.get("metadata", {}),
                callback=item.get("callback")
            )
            task_ids.append(task_id)
        return task_ids

    def get_status(self, task_id: str) -> Optional[WriteTask]:
        with self._lock:
            return self._results.get(task_id)

    def wait_for_completion(self, task_ids: List[str], timeout: float = 30.0) -> BatchResult:
        start_time = time.time()
        successful = 0
        failed = 0
        errors = []
        
        while time.time() - start_time < timeout:
            all_done = True
            
            with self._lock:
                for task_id in task_ids:
                    task = self._results.get(task_id)
                    if task is None:
                        continue
                    
                    if task.status == WriteStatus.PENDING or task.status == WriteStatus.PROCESSING:
                        all_done = False
                    elif task.status == WriteStatus.COMPLETED:
                        successful += 1
                    elif task.status == WriteStatus.FAILED:
                        failed += 1
                        if task.error:
                            errors.append({"task_id": task_id, "error": task.error})
            
            if all_done:
                break
            
            time.sleep(0.1)
        
        return BatchResult(
            total=len(task_ids),
            successful=successful,
            failed=failed,
            task_ids=task_ids,
            errors=errors
        )

    def _worker_loop(self):
        while self._running:
            try:
                task = self._queue.get(timeout=1.0)
                if task is None:
                    continue
                
                self._process_task(task)
            except queue.Empty:
                continue
            except Exception as e:
                logger.error(f"Worker error: {e}")

    def _process_task(self, task: WriteTask):
        if not self._processor:
            with self._lock:
                task.status = WriteStatus.FAILED
                task.error = "No processor configured"
            return
        
        try:
            with self._lock:
                task.status = WriteStatus.PROCESSING
            
            result = self._processor(task.text, task.metadata, task.vector)
            
            with self._lock:
                task.status = WriteStatus.COMPLETED
                task.result = result
                task.completed_at = time.time()
            
            if task.id in self._callbacks:
                try:
                    self._callbacks[task.id](task)
                except Exception as e:
                    logger.warning(f"Callback error: {e}")
        
        except Exception as e:
            with self._lock:
                task.retries += 1
                if task.retries < task.max_retries:
                    task.status = WriteStatus.PENDING
                    self._queue.put(task)
                    logger.warning(f"Task {task.id} failed, retrying ({task.retries}/{task.max_retries})")
                else:
                    task.status = WriteStatus.FAILED
                    task.error = str(e)
                    logger.error(f"Task {task.id} failed permanently: {e}")

    def get_stats(self) -> dict:
        with self._lock:
            status_counts = defaultdict(int)
            for task in self._results.values():
                status_counts[task.status.value] += 1
            
            return {
                "queue_size": self._queue.qsize(),
                "total_tasks": len(self._results),
                "status_counts": dict(status_counts),
                "workers": len(self._workers)
            }

    def clear_completed(self, max_age: float = 3600.0):
        now = time.time()
        with self._lock:
            to_remove = []
            for task_id, task in self._results.items():
                if task.status in (WriteStatus.COMPLETED, WriteStatus.FAILED):
                    if task.completed_at and (now - task.completed_at) > max_age:
                        to_remove.append(task_id)
            
            for task_id in to_remove:
                del self._results[task_id]
                self._callbacks.pop(task_id, None)


class BatchEmbeddingProcessor:
    def __init__(self, embedding_module, batch_size: int = 20, max_concurrent: int = 3):
        self.embedding_module = embedding_module
        self.batch_size = batch_size
        self.max_concurrent = max_concurrent
        self._semaphore = threading.Semaphore(max_concurrent)

    def process_batch(self, texts: List[str]) -> List[List[float]]:
        if not texts:
            return []
        
        results = []
        
        for i in range(0, len(texts), self.batch_size):
            batch = texts[i:i + self.batch_size]
            
            with self._semaphore:
                try:
                    embeddings = self.embedding_module.embed_text(batch)
                    results.extend(embeddings)
                except Exception as e:
                    logger.error(f"Batch embedding error: {e}")
                    results.extend([[0.0] * self.embedding_module.dimensions] * len(batch))
        
        return results

    def process_with_cache(self, texts: List[str]) -> List[List[float]]:
        results = []
        uncached_texts = []
        uncached_indices = []
        
        for i, text in enumerate(texts):
            cached = self.embedding_module._cache.get(
                self.embedding_module._get_cache_key(text)
            )
            if cached:
                results.append(list(cached))
            else:
                results.append(None)
                uncached_texts.append(text)
                uncached_indices.append(i)
        
        if uncached_texts:
            new_embeddings = self.process_batch(uncached_texts)
            
            for idx, embedding in zip(uncached_indices, new_embeddings):
                results[idx] = embedding
        
        return results

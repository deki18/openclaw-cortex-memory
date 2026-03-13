import logging
import re
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional, Tuple

logger = logging.getLogger(__name__)


class ChunkLevel(Enum):
    L0_SENTENCE = "L0"
    L1_SUMMARY = "L1"
    L2_FULL = "L2"


@dataclass
class SemanticChunk:
    text: str
    level: ChunkLevel
    start_pos: int = 0
    end_pos: int = 0
    parent_id: Optional[str] = None
    children_ids: List[str] = field(default_factory=list)
    metadata: dict = field(default_factory=dict)
    importance_score: float = 0.0
    tags: List[str] = field(default_factory=list)
    entities: List[str] = field(default_factory=list)
    summary: Optional[str] = None


class SemanticChunker:
    SENTENCE_ENDINGS = re.compile(r'[。！？.!?]\s*')
    PARAGRAPH_BREAK = re.compile(r'\n\s*\n')
    MIN_CHUNK_SIZE = 100
    MAX_CHUNK_SIZE = 600
    TARGET_CHUNK_SIZE = 300
    OVERLAP_SIZE = 100
    
    def __init__(self, config: dict = None):
        config = config or {}
        self.min_chunk_size = config.get("min_chunk_size", self.MIN_CHUNK_SIZE)
        self.max_chunk_size = config.get("max_chunk_size", self.MAX_CHUNK_SIZE)
        self.target_chunk_size = config.get("target_chunk_size", self.TARGET_CHUNK_SIZE)
        self.overlap_size = config.get("overlap_size", self.OVERLAP_SIZE)
        self.respect_sentence_boundary = config.get("respect_sentence_boundary", True)
        self.respect_paragraph_boundary = config.get("respect_paragraph_boundary", True)

    def chunk(self, text: str, source: str = "") -> List[SemanticChunk]:
        if not text or not text.strip():
            return []
        
        text = text.strip()
        
        if len(text) <= self.min_chunk_size:
            return [SemanticChunk(
                text=text,
                level=ChunkLevel.L2_FULL,
                start_pos=0,
                end_pos=len(text),
                metadata={"source": source}
            )]
        
        paragraphs = self._split_paragraphs(text)
        chunks = []
        current_pos = 0
        
        for para in paragraphs:
            para_start = text.find(para, current_pos)
            para_end = para_start + len(para)
            
            if len(para) <= self.max_chunk_size:
                chunk = SemanticChunk(
                    text=para.strip(),
                    level=ChunkLevel.L2_FULL,
                    start_pos=para_start,
                    end_pos=para_end,
                    metadata={"source": source, "is_paragraph": True}
                )
                chunks.append(chunk)
            else:
                sub_chunks = self._chunk_large_paragraph(para, para_start, source)
                chunks.extend(sub_chunks)
            
            current_pos = para_end
        
        return chunks

    def _split_paragraphs(self, text: str) -> List[str]:
        paragraphs = self.PARAGRAPH_BREAK.split(text)
        return [p.strip() for p in paragraphs if p.strip()]

    def _chunk_large_paragraph(self, text: str, start_offset: int, source: str) -> List[SemanticChunk]:
        sentences = self._split_sentences(text)
        chunks = []
        current_chunk = []
        current_size = 0
        chunk_start = start_offset
        
        for sentence in sentences:
            sentence_size = len(sentence)
            
            if current_size + sentence_size > self.max_chunk_size and current_chunk:
                chunk_text = "".join(current_chunk)
                chunks.append(SemanticChunk(
                    text=chunk_text.strip(),
                    level=ChunkLevel.L2_FULL,
                    start_pos=chunk_start,
                    end_pos=chunk_start + len(chunk_text),
                    metadata={"source": source}
                ))
                
                overlap_text = self._get_overlap_text(current_chunk)
                current_chunk = [overlap_text, sentence] if overlap_text else [sentence]
                current_size = len("".join(current_chunk))
                chunk_start = start_offset + text.find(sentence, chunk_start - start_offset + len(chunk_text) - len(overlap_text))
            else:
                current_chunk.append(sentence)
                current_size += sentence_size
        
        if current_chunk:
            chunk_text = "".join(current_chunk)
            chunks.append(SemanticChunk(
                text=chunk_text.strip(),
                level=ChunkLevel.L2_FULL,
                start_pos=chunk_start,
                end_pos=chunk_start + len(chunk_text),
                metadata={"source": source}
            ))
        
        return chunks

    def _split_sentences(self, text: str) -> List[str]:
        sentences = []
        last_end = 0
        
        for match in self.SENTENCE_ENDINGS.finditer(text):
            end = match.end()
            sentence = text[last_end:end].strip()
            if sentence:
                sentences.append(sentence)
            last_end = end
        
        if last_end < len(text):
            remaining = text[last_end:].strip()
            if remaining:
                sentences.append(remaining)
        
        return sentences

    def _get_overlap_text(self, sentences: List[str]) -> str:
        if not sentences:
            return ""
        
        overlap = ""
        for sentence in reversed(sentences):
            if len(overlap) + len(sentence) <= self.overlap_size:
                overlap = sentence + overlap
            else:
                break
        
        return overlap

    def recursive_chunk(self, text: str, source: str = "", max_levels: int = 3) -> List[SemanticChunk]:
        if not text or not text.strip():
            return []
        
        all_chunks = []
        
        l2_chunks = self.chunk(text, source)
        all_chunks.extend(l2_chunks)
        
        if max_levels >= 2:
            for l2_chunk in l2_chunks:
                l1_chunks = self._create_l1_chunks(l2_chunk)
                all_chunks.extend(l1_chunks)
        
        if max_levels >= 3:
            for chunk in all_chunks:
                if chunk.level == ChunkLevel.L1_SUMMARY:
                    l0_chunks = self._create_l0_chunks(chunk)
                    all_chunks.extend(l0_chunks)
        
        return all_chunks

    def _create_l1_chunks(self, l2_chunk: SemanticChunk) -> List[SemanticChunk]:
        sentences = self._split_sentences(l2_chunk.text)
        chunks = []
        
        for i, sentence in enumerate(sentences):
            if len(sentence) >= 20:
                chunk = SemanticChunk(
                    text=sentence,
                    level=ChunkLevel.L1_SUMMARY,
                    parent_id=id(l2_chunk),
                    metadata={"source": l2_chunk.metadata.get("source", ""), "sentence_index": i}
                )
                chunks.append(chunk)
        
        return chunks

    def _create_l0_chunks(self, l1_chunk: SemanticChunk) -> List[SemanticChunk]:
        words = l1_chunk.text.split()
        if len(words) < 5:
            return []
        
        key_phrases = self._extract_key_phrases(l1_chunk.text)
        chunks = []
        
        for phrase in key_phrases:
            if len(phrase) >= 3:
                chunk = SemanticChunk(
                    text=phrase,
                    level=ChunkLevel.L0_SENTENCE,
                    parent_id=id(l1_chunk),
                    metadata={"source": l1_chunk.metadata.get("source", "")}
                )
                chunks.append(chunk)
        
        return chunks

    def _extract_key_phrases(self, text: str) -> List[str]:
        words = text.split()
        phrases = []
        
        for i in range(len(words) - 1):
            phrase = f"{words[i]} {words[i+1]}"
            if len(phrase) >= 4:
                phrases.append(phrase)
        
        return list(set(phrases))[:5]


class ChunkMerger:
    def __init__(self, min_size: int = 100, max_size: int = 800):
        self.min_size = min_size
        self.max_size = max_size

    def merge_small_chunks(self, chunks: List[SemanticChunk]) -> List[SemanticChunk]:
        if not chunks:
            return []
        
        merged = []
        current_group = []
        current_size = 0
        
        for chunk in chunks:
            if current_size + len(chunk.text) <= self.max_size:
                current_group.append(chunk)
                current_size += len(chunk.text)
            else:
                if current_group:
                    merged.append(self._merge_group(current_group))
                current_group = [chunk]
                current_size = len(chunk.text)
        
        if current_group:
            if len(current_group) == 1 and current_size < self.min_size and merged:
                last_merged = merged[-1]
                combined_text = last_merged.text + "\n" + current_group[0].text
                if len(combined_text) <= self.max_size:
                    merged[-1] = SemanticChunk(
                        text=combined_text,
                        level=last_merged.level,
                        metadata=last_merged.metadata
                    )
                else:
                    merged.append(self._merge_group(current_group))
            else:
                merged.append(self._merge_group(current_group))
        
        return merged

    def _merge_group(self, chunks: List[SemanticChunk]) -> SemanticChunk:
        if len(chunks) == 1:
            return chunks[0]
        
        combined_text = "\n".join(c.text for c in chunks)
        return SemanticChunk(
            text=combined_text,
            level=chunks[0].level,
            start_pos=chunks[0].start_pos,
            end_pos=chunks[-1].end_pos,
            metadata={"merged_from": len(chunks), "source": chunks[0].metadata.get("source", "")}
        )

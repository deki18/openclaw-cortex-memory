import logging
import re
import unicodedata
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


@dataclass
class PreprocessConfig:
    remove_extra_whitespace: bool = True
    normalize_newlines: bool = True
    remove_html_tags: bool = True
    normalize_unicode: bool = True
    remove_control_chars: bool = True
    min_text_length: int = 1
    max_text_length: int = 100000


class TextPreprocessor:
    """文本预处理器
    
    功能：
    1. 去除多余空白字符
    2. 统一换行符
    3. 去除HTML标签
    4. Unicode规范化
    5. 去除控制字符
    6. 文本长度验证
    """
    
    def __init__(self, config: PreprocessConfig = None):
        self.config = config or PreprocessConfig()
        
        self._html_pattern = re.compile(
            r'<[^>]+>',
            re.IGNORECASE
        )
        
        self._whitespace_pattern = re.compile(
            r'[ \t]+'
        )
        
        self._newline_pattern = re.compile(
            r'\n{3,}'
        )
    
    def preprocess(self, text: str) -> str:
        if not text:
            return ""
        
        if self.config.normalize_unicode:
            text = self._normalize_unicode(text)
        
        if self.config.remove_control_chars:
            text = self._remove_control_chars(text)
        
        if self.config.remove_html_tags:
            text = self._remove_html_tags(text)
        
        if self.config.normalize_newlines:
            text = self._normalize_newlines(text)
        
        if self.config.remove_extra_whitespace:
            text = self._remove_extra_whitespace(text)
        
        text = text.strip()
        
        if len(text) < self.config.min_text_length:
            logger.warning(f"Text too short: {len(text)} chars")
            return ""
        
        if len(text) > self.config.max_text_length:
            logger.warning(f"Text too long, truncating: {len(text)} -> {self.config.max_text_length}")
            text = text[:self.config.max_text_length]
        
        return text
    
    def _normalize_unicode(self, text: str) -> str:
        try:
            return unicodedata.normalize('NFKC', text)
        except Exception as e:
            logger.warning(f"Unicode normalization failed: {e}")
            return text
    
    def _remove_control_chars(self, text: str) -> str:
        result = []
        for char in text:
            if ord(char) < 32:
                if char in '\n\r\t':
                    result.append(char)
            else:
                result.append(char)
        return ''.join(result)
    
    def _remove_html_tags(self, text: str) -> str:
        return self._html_pattern.sub('', text)
    
    def _normalize_newlines(self, text: str) -> str:
        text = text.replace('\r\n', '\n')
        text = text.replace('\r', '\n')
        text = self._newline_pattern.sub('\n\n', text)
        return text
    
    def _remove_extra_whitespace(self, text: str) -> str:
        text = self._whitespace_pattern.sub(' ', text)
        lines = text.split('\n')
        lines = [line.strip() for line in lines]
        text = '\n'.join(lines)
        return text
    
    def is_valid(self, text: str) -> bool:
        if not text:
            return False
        
        text = text.strip()
        
        if len(text) < self.config.min_text_length:
            return False
        
        if len(text) > self.config.max_text_length:
            return False
        
        return True
    
    def get_stats(self, text: str) -> dict:
        if not text:
            return {
                "length": 0,
                "lines": 0,
                "words": 0,
                "chars": 0
            }
        
        text = text.strip()
        lines = text.split('\n')
        words = text.split()
        
        return {
            "length": len(text),
            "lines": len(lines),
            "words": len(words),
            "chars": len(text.replace(' ', '').replace('\n', ''))
        }


def create_preprocessor(config: dict = None) -> TextPreprocessor:
    if config is None:
        return TextPreprocessor()
    
    preprocess_config = PreprocessConfig(
        remove_extra_whitespace=config.get("remove_extra_whitespace", True),
        normalize_newlines=config.get("normalize_newlines", True),
        remove_html_tags=config.get("remove_html_tags", True),
        normalize_unicode=config.get("normalize_unicode", True),
        remove_control_chars=config.get("remove_control_chars", True),
        min_text_length=config.get("min_text_length", 1),
        max_text_length=config.get("max_text_length", 100000)
    )
    
    return TextPreprocessor(preprocess_config)

import logging
import os
import re

import yaml

logger = logging.getLogger(__name__)

RULE_NAME_PATTERN = re.compile(r'^[a-zA-Z0-9_-]+$')


def _validate_rule_name(rule_name: str) -> bool:
    return bool(RULE_NAME_PATTERN.match(rule_name))


def _safe_path(rules_dir: str, rule_name: str) -> str:
    if not _validate_rule_name(rule_name):
        raise ValueError(f"Invalid rule name: {rule_name}")
    path = os.path.join(rules_dir, f"{rule_name}.yaml")
    real_path = os.path.realpath(path)
    real_rules_dir = os.path.realpath(rules_dir)
    if not real_path.startswith(real_rules_dir + os.sep) and real_path != os.path.join(real_rules_dir, f"{rule_name}.yaml"):
        raise ValueError(f"Path traversal detected: {rule_name}")
    return path


class ProceduralMemory:
    def __init__(self, rules_dir="~/.openclaw/workspace/procedures"):
        self.rules_dir = os.path.expanduser(rules_dir)
        os.makedirs(self.rules_dir, exist_ok=True)

    def add_rule(self, rule_name: str, content):
        try:
            path = _safe_path(self.rules_dir, rule_name)
            with open(path, "w", encoding="utf-8") as f:
                yaml.safe_dump(content, f, allow_unicode=True, sort_keys=False)
            logger.info(f"Added rule: {rule_name}")
        except ValueError as e:
            logger.error(f"Invalid rule name {rule_name}: {e}")
        except Exception as e:
            logger.error(f"Failed to add rule {rule_name}: {e}")

    def get_rules(self):
        rules = []
        if not os.path.isdir(self.rules_dir):
            return rules
        for filename in os.listdir(self.rules_dir):
            if filename.endswith(".yaml"):
                try:
                    with open(os.path.join(self.rules_dir, filename), "r", encoding="utf-8") as f:
                        rules.append(yaml.safe_load(f))
                except Exception as e:
                    logger.warning(f"Failed to load rule {filename}: {e}")
        return rules

    def get_rule(self, rule_name: str):
        try:
            path = _safe_path(self.rules_dir, rule_name)
            if not os.path.exists(path):
                return None
            with open(path, "r", encoding="utf-8") as f:
                return yaml.safe_load(f)
        except ValueError as e:
            logger.error(f"Invalid rule name {rule_name}: {e}")
            return None
        except Exception as e:
            logger.error(f"Failed to get rule {rule_name}: {e}")
            return None

    def delete_rule(self, rule_name: str):
        try:
            path = _safe_path(self.rules_dir, rule_name)
            if os.path.exists(path):
                os.remove(path)
                logger.info(f"Deleted rule: {rule_name}")
        except ValueError as e:
            logger.error(f"Invalid rule name {rule_name}: {e}")
        except Exception as e:
            logger.error(f"Failed to delete rule {rule_name}: {e}")

    def list_rules(self):
        if not os.path.isdir(self.rules_dir):
            return []
        return [f[:-5] for f in os.listdir(self.rules_dir) if f.endswith(".yaml")]

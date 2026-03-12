import logging
import os

import yaml

logger = logging.getLogger(__name__)


class ProceduralMemory:
    def __init__(self, rules_dir="~/.openclaw/workspace/procedures"):
        self.rules_dir = os.path.expanduser(rules_dir)
        os.makedirs(self.rules_dir, exist_ok=True)

    def add_rule(self, rule_name: str, content):
        path = os.path.join(self.rules_dir, f"{rule_name}.yaml")
        try:
            with open(path, "w", encoding="utf-8") as f:
                yaml.safe_dump(content, f, allow_unicode=True, sort_keys=False)
            logger.info(f"Added rule: {rule_name}")
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
        path = os.path.join(self.rules_dir, f"{rule_name}.yaml")
        if not os.path.exists(path):
            return None
        try:
            with open(path, "r", encoding="utf-8") as f:
                return yaml.safe_load(f)
        except Exception as e:
            logger.error(f"Failed to get rule {rule_name}: {e}")
            return None

    def delete_rule(self, rule_name: str):
        path = os.path.join(self.rules_dir, f"{rule_name}.yaml")
        if os.path.exists(path):
            try:
                os.remove(path)
                logger.info(f"Deleted rule: {rule_name}")
            except Exception as e:
                logger.error(f"Failed to delete rule {rule_name}: {e}")

    def list_rules(self):
        if not os.path.isdir(self.rules_dir):
            return []
        return [f[:-5] for f in os.listdir(self.rules_dir) if f.endswith(".yaml")]

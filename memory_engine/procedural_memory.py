import os
import yaml

class ProceduralMemory:
    def __init__(self, rules_dir="~/.openclaw/workspace/procedures"):
        self.rules_dir = os.path.expanduser(rules_dir)
        os.makedirs(self.rules_dir, exist_ok=True)

    def add_rule(self, rule_name: str, content):
        path = os.path.join(self.rules_dir, f"{rule_name}.yaml")
        with open(path, "w", encoding="utf-8") as f:
            yaml.safe_dump(content, f, allow_unicode=True, sort_keys=False)

    def get_rules(self):
        rules = []
        for filename in os.listdir(self.rules_dir):
            if filename.endswith(".yaml"):
                with open(os.path.join(self.rules_dir, filename), "r", encoding="utf-8") as f:
                    rules.append(yaml.safe_load(f))
        return rules

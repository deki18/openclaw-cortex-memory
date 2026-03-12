import os

def read_cold_archive(path: str):
    full_path = os.path.expanduser(path)
    if not os.path.exists(full_path):
        return f"Archive not found: {path}"
        
    with open(full_path, "r") as f:
        return f.read()

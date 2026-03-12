from memory_engine.memory_controller import MemoryController

controller = MemoryController()

def search_memory(query: str):
    results = controller.search_memory(query)
    return results

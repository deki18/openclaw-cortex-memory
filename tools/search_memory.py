from memory_engine.enhanced_controller import EnhancedMemoryController

controller = EnhancedMemoryController()
controller.start()

def search_memory(query: str, top_k: int = 10):
    result = controller.search(query, top_k=top_k)
    return result.items

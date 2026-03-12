from memory_engine.memory_controller import MemoryController

controller = MemoryController()

def query_graph(entity: str):
    return controller.query_graph(entity)

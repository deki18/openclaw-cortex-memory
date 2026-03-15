from memory_engine.enhanced_controller import EnhancedMemoryController

controller = EnhancedMemoryController()
controller.start()

def query_graph(entity: str):
    return controller.query_graph(entity)

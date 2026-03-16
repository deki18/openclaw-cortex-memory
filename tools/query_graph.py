from memory_engine.enhanced_controller import get_controller

controller = get_controller()
controller.start()

def query_graph(entity: str):
    return controller.query_graph(entity)

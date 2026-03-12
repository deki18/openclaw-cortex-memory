from memory_engine.memory_controller import MemoryController

controller = MemoryController()

def store_event(summary: str, entities: list = None, outcome: str = "", relations: list = None):
    return controller.store_event(summary, entities, outcome, relations)

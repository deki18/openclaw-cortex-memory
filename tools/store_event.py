from memory_engine.enhanced_controller import EnhancedMemoryController

controller = EnhancedMemoryController()
controller.start()

def store_event(summary: str, entities: list = None, outcome: str = "", relations: list = None):
    return controller.store_event(summary, entities=entities, outcome=outcome, relations=relations)

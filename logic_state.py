# =========================================================================
# LOGIC STATE: STRUCTURAL REASONING LAYER
# =========================================================================

class LogicState:
    def __init__(self):
        self.last_result = None

    def handle(self, task):
        self.last_result = {
            "evaluated": True,
            "payload": task.payload,
        }
        return {
            "domain": "logic",
            "result": self.last_result,
        }

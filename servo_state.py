# =========================================================================
# SERVO STATE: COMMAND CHANNEL (NO AUDIO / NO SERIAL)
# =========================================================================

class ServoState:
    def __init__(self):
        self.last_command = None

    def handle(self, task):
        self.last_command = task.payload
        return {
            "domain": "servo",
            "command": self.last_command,
            "status": "OK",
        }

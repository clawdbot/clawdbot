# =========================================================================
# TELEMETRY STATE: SILENT FLOW EVENTS
# =========================================================================

class TelemetryState:
    def __init__(self):
        self.events = []

    def handle(self, task):
        self.events.append(task.payload)
        return {
            "domain": "telemetry",
            "event_count": len(self.events),
            "status": "RECORDED",
        }

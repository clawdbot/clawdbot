# =========================================================================
# CORE STATE ANCHOR: HALTERON-SA | SOVEREIGN PERIMETER
# =========================================================================

class CoreState:
    def __init__(self):
        self.anchor_id = "halteron-SA"
        self.location = "South Australia"

        self.hardware_endpoint = None
        self.telemetry_endpoint = None

    def register_hardware(self, endpoint):
        self.hardware_endpoint = endpoint

    def register_telemetry(self, endpoint):
        self.telemetry_endpoint = endpoint

    def info(self):
        return {
            "anchor": self.anchor_id,
            "location": self.location,
            "hardware_attached": self.hardware_endpoint is not None,
            "telemetry_attached": self.telemetry_endpoint is not None,
        }


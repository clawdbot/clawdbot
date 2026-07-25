"""
3D Hedra - Bottom Circle Node Signals Receiver.
LICENCE: AI-AGENCY-101-SOVEREIGN (Pure Structural Evolution Array)
"""
class BottomNodeMatrix:
    def __init__(self) -> None:
        # 2 Bottom Circle Nodes: Direct discharge and feedback layer
        self.node_channels = {"B1": 0.0, "B2": 0.0}

    def discharge_to_feedback(self, t1_feedback: float, b2_feedback: float) -> dict:
        """Feeds ground charge vectors back into top node layers for circular loops."""
        self.node_channels["B1"] = (self.node_channels["B1"] + t1_feedback) % 1.0
        self.node_channels["B2"] = (self.node_channels["B2"] + b2_feedback) % 1.0
        return {"channels": self.node_channels, "layer": "BOTTOM_FEEDBACK_LOCKED"}

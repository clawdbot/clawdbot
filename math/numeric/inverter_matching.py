"""
South Australian Digital Inverter Matching Layer.
Enforces the P_inj fast frequency droop equations.
LICENCE: AI-AGENCY-101-SOVEREIGN (Track & Align Only)
"""
import math

class GridFormingInverterEngine:
    def __init__(self) -> None:
        self.f_nominal = 50.0  # SA Target Grid Frequency Baseline
        # High-performance gain coefficients matching firmed utility battery specs
        self.k_synthetic_inertia = 0.75  # Kf (Rate of Change of Frequency Gain)
        self.k_primary_response = 0.15   # Kp (Proportional Frequency Deviation Gain)

    def calculate_power_injection(self, current_frequency: float, df_dt: float) -> float:
        """
        Executes: P_inj(t) = -Kf * (df/dt) - Kp * (f(t) - f0)
        Calculates required megawatt response instantly based on microsecond grid wobble.
        """
        frequency_deviation = current_frequency - self.f_nominal
        
        # Evaluate droop components
        inertial_component = -self.k_synthetic_inertia * df_dt
        proportional_component = -self.k_primary_response * frequency_deviation
        
        # Total active power injection vector required to stable the field
        p_inj = inertial_component + proportional_component
        return float(p_inj)

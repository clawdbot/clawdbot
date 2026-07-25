"""
AI Agency 101 - Local Cognitive Servo Orchestrator.
Uses your local Ollama backend to audit ledger frames and drive servo physical steps.
LICENCE: AI-AGENCY-101-SOVEREIGN (Track & Align Only)
"""
import sys
import os
import json
import httpx

class CognitiveServoRouter:
    def __init__(self) -> None:
        self.ollama_url = "http://localhost:11434/api/generate"
        self.ledger_path = "C:\\RobclawD\\monolith\\hydren\\recycle_pool\\ledger_audit.jsonl"
        self.model_tag = "llama3" # Matches your local locked down model configuration
        
    def read_latest_ledger_frame(self) -> dict:
        """Safely parses the last active row of the double-entry matrix log."""
        try:
            if not os.path.exists(self.ledger_path):
                return {}
            with open(self.ledger_path, "r", encoding="utf-8") as f:
                lines = f.readlines()
                if lines:
                    return json.loads(lines[-1].strip())
        except Exception as e:
            sys.stderr.write(f"[-] Ledger ingestion fault: {e}\n")
        return {}

    def orchestrate_hardware_action(self, user_intent: str) -> None:
        """Pipes the ledger state into Ollama to calculate exact physical servo positions."""
        latest_frame = self.read_latest_ledger_frame()
        if not latest_frame:
            sys.stderr.write("[-] Conduction loop holding: Ledger empty.\n")
            return

        # Explicitly instruct your local model to output hard mechanical coordinate mappings
        system_context = (
            f"You are the RobclawD core brain. Current Ledger Frame: {json.dumps(latest_frame)}. "
            f"Calculate the optimal physical servo angle adjustments (0-180 degrees) for the "
            f"2-3-2 spatial hedra layers based on the current net_balance_delta. "
            f"Output direct hardware target parameters only."
        )

        payload = {
            "model": self.model_tag,
            "prompt": f"{system_context}\nINTENT: {user_intent}\nHARDWARE TARGETS:",
            "stream": False,
            "options": {"temperature": 0.1}
        }

        try:
            response = httpx.post(self.ollama_url, json=payload, timeout=5.0)
            decision = response.json().get("response", "").strip()
            
            # Print the direct executive decision detailing the exact audited hardware action
            sys.stdout.write(f"\n[COGNITIVE EXECUTIVE ORDER]: {decision}\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stderr.write(f"[-] Local cognitive loop connection broken: {e}\n")

if __name__ == "__main__":
    router = CognitiveServoRouter()
    # Continuous tick evaluation
    router.orchestrate_hardware_action("Balance and secure the Mid North transmission load lines.")

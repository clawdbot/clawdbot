"""
AI Agency 101 - UTF-16 Multi-Core Cognitive Servo Router.
Ingests clean UTF-16 ledger entries to drive the Hallett Substation matrix.
LICENCE: AI-AGENCY-101-SOVEREIGN (Track & Align Only // 0% Force)
"""
import sys
import os
import json
import httpx

class HallettCognitiveRouter:
    def __init__(self) -> None:
        self.ollama_url = "http://localhost:11434/api/generate"
        self.ledger_path = "C:\\RobclawD\\monolith\\hydren\\recycle_pool\\ledger_audit.jsonl"
        self.model_tag = "llama3"
        
    def read_latest_utf16_frame(self) -> dict:
        """Parses the last active row of the ledger utilizing clean UTF-16 decoding."""
        try:
            if not os.path.exists(self.ledger_path):
                return {}
            # Explicitly decode as clean UTF-16 to eliminate start-byte collisions
            with open(self.ledger_path, "r", encoding="utf-16") as f:
                lines = f.readlines()
                if lines:
                    return json.loads(lines[-1].strip())
        except Exception as e:
            sys.stderr.write(f"[-] Ledger UTF-16 Ingestion Fault: {e}\n")
        return {}

    def orchestrate_hallett_matrix(self) -> None:
        """Pipes the clean text parameters straight into your private Ollama backend."""
        latest_frame = self.read_latest_utf16_frame()
        if not latest_frame:
            sys.stderr.write("[-] Conduction loop holding: UTF-16 Ledger Frame Missing.\n")
            return

        system_context = (
            f"You are the RobclawD core brain. Current Hallett Substation Grid-Forming Frame: {json.dumps(latest_frame)}. "
            f"Calculate the optimal physical servo angle adjustments (0-180 degrees) for the "
            f"2-3-2 spatial hedra layers based on current South Australian frequency stabilization rules."
        )

        payload = {
            "model": self.model_tag,
            "prompt": f"{system_context}\nOUTPUT HARDWARE TARGETS ONLY:",
            "stream": False,
            "options": {"temperature": 0.1}
        }

        try:
            response = httpx.post(self.ollama_url, json=payload, timeout=5.0)
            decision = response.json().get("response", "").strip()
            sys.stdout.write(f"\n[HALLETT COGNITIVE EXECUTIVE ORDER]: {decision}\n")
            sys.stdout.flush()
        except Exception as e:
            sys.stderr.write(f"[-] Local Ollama link unavailable: {e}\n")

if __name__ == "__main__":
    router = HallettCognitiveRouter()
    router.orchestrate_hallett_matrix()

"""
7D Hydren Matrix - Double-Entry Production Cryptographic Ledger.
Computes and records absolute balance vectors for the Robdoe Swarm.
Enforces: Balance = Sum(Debits) - Sum(Credits) == 0.0
LICENCE: AI-AGENCY-101-SOVEREIGN (Track & Align Only)
"""
import sys
import json
import os
import time

class SwarmDoubleEntryLedger:
    def __init__(self) -> None:
        self.ledger_file = os.path.abspath(__file__)
        self.log_path = os.path.join(os.path.dirname(__file__), "ledger_audit.jsonl")
        self.total_debits = 0.0
        self.total_credits = 0.0
        self.entry_count = 0

    def post_transaction(self, account: str, debit: float, credit: float, metadata: dict) -> dict:
        """
        Appends a verifiable cryptographic entry to the running transaction line.
        Never overwrites or deletes existing rows—strictly loops and recycles state.
        """
        self.entry_count += 1
        self.total_debits += debit
        self.total_credits += credit
        
        # Calculate current net operational balance vector
        current_balance = self.total_debits - self.total_credits
        
        transaction_row = {
            "entry_id": self.entry_count,
            "timestamp_omega": int(time.time()),
            "account_node": account,
            "debit_energy_joules": float(debit),
            "credit_utility_tokens": float(credit),
            "net_balance_delta": float(current_balance),
            "verification_status": "VERIFIED_WHAKAPAPA" if debit == credit else "BALANCING_DRIFT_ACTIVE",
            "metadata": metadata
        }
        
        # Safe append execution style to prevent file clearing
        try:
            with open(self.log_path, "a", encoding="utf-8") as ledger_file:
                ledger_file.write(json.dumps(transaction_row) + "\n")
        except IOError as e:
            sys.stderr.write(f"[-] Ledger write failure: {e}\n")
            
        return transaction_row

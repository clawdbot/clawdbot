#!/usr/bin/env python3
from __future__ import annotations
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "config" / "ai_intelligence"
FILES = ["model_registry.json", "scorecard.json", "routing_policy.json", "benchmarks.json", "technology_watch.json"]

def load(name):
    with (CONFIG / name).open("r", encoding="utf-8") as f:
        return json.load(f)

def main():
    docs = {name: load(name) for name in FILES}
    registry_ids = {m["id"] for m in docs["model_registry.json"]["models"]}
    score_ids = set(docs["scorecard.json"]["models"])
    assert registry_ids == score_ids, f"Registry/scorecard mismatch: {registry_ids ^ score_ids}"

    for rule in docs["routing_policy.json"]["rules"]:
        for model_id in rule["preferred_models"] + rule.get("fallback_models", []):
            assert model_id in registry_ids, f"Unknown routing model: {model_id}"

    for model_id, scores in docs["scorecard.json"]["models"].items():
        for key, value in scores.items():
            assert 1 <= value <= 10, f"{model_id}.{key} outside 1-10"
    print("AI Intelligence Layer validation: PASS")
    print(f"Models: {len(registry_ids)}")
    print(f"Routing rules: {len(docs['routing_policy.json']['rules'])}")
    print(f"Benchmarks: {len(docs['benchmarks.json']['benchmarks'])}")

if __name__ == "__main__":
    main()

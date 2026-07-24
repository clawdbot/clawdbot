#!/usr/bin/env python3
from __future__ import annotations
import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "config" / "ai_intelligence"

def load(name: str):
    with (CONFIG / name).open("r", encoding="utf-8") as f:
        return json.load(f)

def weighted_score(model_id: str, scorecard: dict) -> float:
    weights = scorecard["criteria"]
    scores = scorecard["models"][model_id]
    numerator = sum(scores[k] * weights[k] for k in weights)
    denominator = sum(weights.values())
    return round(numerator / denominator, 2)

def main() -> int:
    parser = argparse.ArgumentParser(description="Recommend an OpenClaw model for a task.")
    parser.add_argument("--task", required=True)
    args = parser.parse_args()

    registry = load("model_registry.json")
    scorecard = load("scorecard.json")
    policy = load("routing_policy.json")

    models = {m["id"]: m for m in registry["models"]}
    rule = next((r for r in policy["rules"] if r["task"] == args.task), None)
    if not rule:
        print(f"Unknown task: {args.task}", file=sys.stderr)
        print("Known tasks:", ", ".join(r["task"] for r in policy["rules"]), file=sys.stderr)
        return 2

    required_privacy = rule.get("required_privacy_tier")
    candidates = rule["preferred_models"] + rule.get("fallback_models", [])
    ranked = []
    for model_id in candidates:
        model = models[model_id]
        if required_privacy and model["privacy_tier"] != required_privacy:
            continue
        ranked.append((weighted_score(model_id, scorecard), model_id, model))

    ranked.sort(reverse=True)
    if not ranked:
        print("No eligible model found.", file=sys.stderr)
        return 3

    best_score, best_id, best = ranked[0]
    print(json.dumps({
        "task": args.task,
        "recommended_model": best_id,
        "display_name": best["display_name"],
        "weighted_score": best_score,
        "status": best["status"],
        "privacy_tier": best["privacy_tier"],
        "score_status": scorecard["score_status"],
        "warning": "Scores are provisional until benchmark evidence is recorded."
    }, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

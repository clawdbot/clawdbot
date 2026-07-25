#!/usr/bin/env python3
"""Promote human-approved Evaluation Lab results into the official scorecard.

This command updates only config/ai_intelligence/scorecard.json. It requires
matching current approval, candidate, evaluation, review, validation, registry,
benchmark, and scorecard records. Every successful or idempotent application is
audited. It never changes the production model or routing configuration.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "config/ai_intelligence"
REPORTS = ROOT / "reports/ai_intelligence"

SCORECARD = CONFIG / "scorecard.json"
REGISTRY = CONFIG / "model_registry.json"
BENCHMARKS = CONFIG / "benchmarks.json"
ROUTING = CONFIG / "routing_policy.json"

EVALUATION = REPORTS / "evaluation_lab/evaluation-lab-latest.json"
APPROVAL = REPORTS / "evaluation_approvals/evaluation-approval-latest.json"
CANDIDATES = REPORTS / "evaluation_approvals/approved-scorecard-candidates-latest.json"
REVIEW = REPORTS / "benchmark_reviews/benchmark-review-latest.json"
VALIDATION = REPORTS / "benchmark_validation/benchmark-validation-latest.json"
AUDIT_DIR = REPORTS / "scorecard_promotions"

PROTECTED_ENV = Path("/home/gravesab/.openclaw/credentials/chat-agent.env")
MODEL_ENV_KEY = "OPENCLAW_CHAT_MODEL"


def load(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"Required file not found: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected a JSON object: {path}")
    return value


def digest(path: Path) -> str:
    if not path.exists():
        return "missing"
    return hashlib.sha256(path.read_bytes()).hexdigest()


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temp_path = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        mode = path.stat().st_mode & 0o777 if path.exists() else 0o644
        os.chmod(temp_path, mode)
        os.replace(temp_path, path)
    finally:
        if temp_path.exists():
            temp_path.unlink()


def model_map(registry: dict[str, Any]) -> dict[str, str]:
    result: dict[str, str] = {}
    for model in registry.get("models", []):
        if not isinstance(model, dict) or not model.get("id"):
            continue
        registry_id = str(model["id"])
        result[registry_id] = registry_id
        if registry_id.startswith("ollama-"):
            name = registry_id.removeprefix("ollama-")
            if "-" in name:
                family, tag = name.rsplit("-", 1)
                result[f"{family}:{tag}"] = registry_id
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", metavar="DECISION_ID")
    parser.add_argument("--status", action="store_true")
    args = parser.parse_args()

    approval = load(APPROVAL)
    candidates_doc = load(CANDIDATES)
    evaluation = load(EVALUATION)
    review = load(REVIEW)
    validation = load(VALIDATION)
    scorecard = load(SCORECARD)
    registry = load(REGISTRY)
    benchmarks = load(BENCHMARKS)

    decision_id = str(approval.get("decision_id", ""))
    pipeline_id = str(approval.get("pipeline_id", ""))
    benchmark_run_id = str(approval.get("benchmark_run_id", ""))

    checks = {
        "approval_is_approved": approval.get("decision") == "approved",
        "approval_has_not_changed_scorecard": approval.get("official_scorecard_changed") is False,
        "pipeline_is_current": evaluation.get("pipeline_id") == pipeline_id,
        "approval_matches_evaluation_run": evaluation.get("benchmark_run_id") == benchmark_run_id,
        "approval_matches_review": approval.get("review_id") == review.get("review_id"),
        "approval_matches_validation": approval.get("validation_id") == validation.get("validation_id"),
        "review_matches_run": review.get("benchmark_run_id") == benchmark_run_id,
        "validation_matches_run": validation.get("benchmark_run_id") == benchmark_run_id,
        "candidate_decision_matches": candidates_doc.get("source_decision_id") == decision_id,
        "candidate_pipeline_matches": candidates_doc.get("source_pipeline_id") == pipeline_id,
        "candidates_human_approved": candidates_doc.get("human_approved") is True,
        "candidates_not_already_marked_updated": candidates_doc.get("official_scorecard_updated") is False,
    }
    failed = [name for name, passed in checks.items() if not passed]
    if failed:
        raise RuntimeError("Refusing stale or mismatched approval: " + ", ".join(failed))

    approved = approval.get("approved_scorecard_candidates", [])
    candidates = candidates_doc.get("candidates", [])
    if approved != candidates or not candidates:
        raise RuntimeError("Approval candidates are empty or differ from candidate report.")

    audit_path = AUDIT_DIR / f"scorecard-promotion-{decision_id}.json"
    if audit_path.is_file():
        prior = load(audit_path)
        if prior.get("status") != "applied":
            raise RuntimeError(f"Existing non-applied audit blocks retry: {audit_path}")
        print("Official scorecard promotion: ALREADY APPLIED")
        print("Decision ID:", decision_id)
        print("Audit:", audit_path)
        print("Production model changed: no")
        print("Automatic routing enabled: no")
        return 0

    benchmark_index = {
        str(item["id"]): item
        for item in benchmarks.get("benchmarks", [])
        if isinstance(item, dict) and item.get("id")
    }
    registry_ids = model_map(registry)
    review_items = review.get("benchmark_reviews", {})
    validation_index = {
        (str(item.get("benchmark_id")), str(item.get("ollama_name"))): item
        for item in validation.get("results", [])
        if isinstance(item, dict)
    }

    changes: list[dict[str, Any]] = []
    for candidate in candidates:
        benchmark_id = str(candidate.get("benchmark_id", ""))
        model_name = str(candidate.get("model", ""))
        if candidate.get("promotion_eligible") is not True:
            raise RuntimeError(f"Candidate is not promotion eligible: {benchmark_id}")
        if candidate.get("deterministic_validation_passed") is not True:
            raise RuntimeError(f"Candidate did not pass validation: {benchmark_id}")

        reconciliation = evaluation.get("benchmark_reconciliation", {}).get(benchmark_id, {})
        if not (
            reconciliation.get("promotion_eligible") is True
            and reconciliation.get("final_winner") == model_name
            and reconciliation.get("winner_passed_deterministic_validation") is True
        ):
            raise RuntimeError(f"Evaluation does not authorize candidate: {benchmark_id}")

        validated = validation_index.get((benchmark_id, model_name), {})
        if validated.get("passed_deterministic_checks") is not True:
            raise RuntimeError(f"Live validation report rejects candidate: {benchmark_id}")

        benchmark = benchmark_index.get(benchmark_id)
        if not benchmark:
            raise RuntimeError(f"Unknown benchmark: {benchmark_id}")
        criterion = str(benchmark.get("category", ""))
        if criterion not in scorecard.get("criteria", {}):
            raise RuntimeError(f"Benchmark category is not a scorecard criterion: {criterion}")

        registry_id = registry_ids.get(model_name)
        if not registry_id or registry_id not in scorecard.get("models", {}):
            raise RuntimeError(f"Cannot map candidate model to scorecard: {model_name}")

        review_item = review_items.get(benchmark_id, {})
        if review_item.get("winner") != model_name or review_item.get("benchmark_status") != "passed":
            raise RuntimeError(f"AI review does not contain a passing winner: {benchmark_id}")
        proposed_score = review_item.get("scores", {}).get(model_name)
        if not isinstance(proposed_score, (int, float)) or not 1 <= proposed_score <= 10:
            raise RuntimeError(f"Invalid approved score for {benchmark_id}: {proposed_score}")

        old_score = scorecard["models"][registry_id].get(criterion)
        scorecard["models"][registry_id][criterion] = proposed_score
        changes.append({
            "benchmark_id": benchmark_id,
            "criterion": criterion,
            "model": model_name,
            "registry_id": registry_id,
            "old_score": old_score,
            "new_score": proposed_score,
        })

    if not args.apply:
        print("Official scorecard promotion: READY")
        print("Decision ID:", decision_id)
        for change in changes:
            print(
                f" - {change['registry_id']}.{change['criterion']}: "
                f"{change['old_score']} -> {change['new_score']}"
            )
        print(f"Apply with: python3 {Path(__file__)} --apply {decision_id}")
        print("Production model changed: no")
        print("Automatic routing enabled: no")
        return 0

    if args.apply != decision_id:
        raise RuntimeError(
            f"Decision ID mismatch: expected {decision_id}, received {args.apply}"
        )

    before = {
        "scorecard": digest(SCORECARD),
        "routing_policy": digest(ROUTING),
        "chat_agent_env": digest(PROTECTED_ENV),
    }
    timestamp = datetime.now().astimezone()
    backup = SCORECARD.with_name(
        f"scorecard.json.before-approved-promotion-{timestamp:%Y%m%d-%H%M%S}"
    )
    shutil.copy2(SCORECARD, backup)
    atomic_json(SCORECARD, scorecard)
    after = {
        "scorecard": digest(SCORECARD),
        "routing_policy": digest(ROUTING),
        "chat_agent_env": digest(PROTECTED_ENV),
    }
    if before["routing_policy"] != after["routing_policy"] or before["chat_agent_env"] != after["chat_agent_env"]:
        shutil.copy2(backup, SCORECARD)
        raise RuntimeError("Protected routing/model configuration changed; scorecard restored.")

    audit = {
        "schema_version": 1,
        "status": "applied",
        "applied_at": timestamp.isoformat(),
        "operator": os.environ.get("SUDO_USER") or os.environ.get("USER") or "unknown",
        "decision_id": decision_id,
        "pipeline_id": pipeline_id,
        "benchmark_run_id": benchmark_run_id,
        "changes": changes,
        "backup": str(backup),
        "hashes_before": before,
        "hashes_after": after,
        "official_scorecard_updated": True,
        "production_model_changed": False,
        "automatic_routing_enabled": False,
    }
    atomic_json(audit_path, audit)

    latest_audit = AUDIT_DIR / "scorecard-promotion-latest.json"
    atomic_json(latest_audit, audit)
    print("Official scorecard promotion: APPLIED")
    print("Decision ID:", decision_id)
    print("Changes:", len(changes))
    print("Backup:", backup)
    print("Audit:", audit_path)
    print("Production model changed: no")
    print("Automatic routing enabled: no")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Official scorecard promotion refused: {exc}", file=sys.stderr)
        raise SystemExit(1)

#!/usr/bin/env python3
"""Record an immutable human decision for the latest Evaluation Lab report."""

from __future__ import annotations

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
REPORTS = ROOT / "reports/ai_intelligence"
EVALUATION = REPORTS / "evaluation_lab/evaluation-lab-latest.json"
APPROVAL_DIR = REPORTS / "evaluation_approvals"
LATEST_APPROVAL = APPROVAL_DIR / "evaluation-approval-latest.json"
LATEST_CANDIDATES = APPROVAL_DIR / "approved-scorecard-candidates-latest.json"


def load(path: Path) -> dict[str, Any]:
    if not path.is_file():
        raise FileNotFoundError(f"Required file not found: {path}")
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise ValueError(f"Expected JSON object: {path}")
    return value


def write_new(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        raise FileExistsError(f"Immutable decision already exists: {path}")
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def write_latest(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary_path, path)
    finally:
        if temporary_path.exists():
            temporary_path.unlink()


def eligible_candidates(evaluation: dict[str, Any]) -> list[dict[str, Any]]:
    candidates: list[dict[str, Any]] = []
    for benchmark_id, result in evaluation.get(
        "benchmark_reconciliation", {}
    ).items():
        if not (
            result.get("promotion_eligible") is True
            and result.get("winner_passed_deterministic_validation") is True
            and result.get("final_winner")
        ):
            continue
        candidates.append(
            {
                "benchmark_id": benchmark_id,
                "model": result["final_winner"],
                "final_status": result.get("final_status"),
                "deterministic_validation_passed": True,
                "promotion_eligible": True,
            }
        )
    return candidates


def main() -> int:
    parser = argparse.ArgumentParser()
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--approve", metavar="PIPELINE_ID")
    group.add_argument("--reject", metavar="PIPELINE_ID")
    group.add_argument("--status", action="store_true")
    parser.add_argument("--note", default="")
    args = parser.parse_args()

    evaluation = load(EVALUATION)
    pipeline_id = str(evaluation.get("pipeline_id", ""))
    candidates = eligible_candidates(evaluation)

    if not args.approve and not args.reject:
        print("RanchBrain Evaluation Approval Status")
        print("Pipeline ID:", pipeline_id)
        print("Promotion-eligible wins:", len(candidates))
        for candidate in candidates:
            print(f" - {candidate['benchmark_id']}: {candidate['model']}")
        if LATEST_APPROVAL.is_file():
            decision = load(LATEST_APPROVAL)
            print("Recorded decision:", decision.get("decision"))
            print("Decision ID:", decision.get("decision_id"))
        else:
            print("Recorded decision: none")
        print("Production model changed: no")
        print("Automatic routing enabled: no")
        print("Official scorecard changed: no")
        return 0

    requested = args.approve or args.reject
    if requested != pipeline_id:
        raise RuntimeError(
            f"Pipeline ID mismatch: current={pipeline_id}, requested={requested}"
        )

    existing = sorted(
        APPROVAL_DIR.glob(f"evaluation-approval-{pipeline_id}-*.json")
    ) if APPROVAL_DIR.is_dir() else []
    if existing:
        prior = load(existing[-1])
        print("Human decision already recorded:", prior.get("decision"))
        print("Decision ID:", prior.get("decision_id"))
        return 0

    decision = "approved" if args.approve else "rejected"
    if decision == "approved" and not candidates:
        raise RuntimeError("No promotion-eligible candidates exist.")

    now = datetime.now().astimezone()
    decision_id = f"{pipeline_id}-{now:%Y%m%d-%H%M%S}"
    record = {
        "schema_version": 1,
        "decision_id": decision_id,
        "pipeline_id": pipeline_id,
        "benchmark_run_id": evaluation.get("benchmark_run_id"),
        "validation_id": evaluation.get("validation_id"),
        "review_id": evaluation.get("review_id"),
        "decision": decision,
        "decided_at": now.isoformat(),
        "operator": os.environ.get("SUDO_USER") or os.environ.get("USER") or "unknown",
        "note": args.note.strip(),
        "approved_scorecard_candidates": candidates if decision == "approved" else [],
        "production_model_changed": False,
        "automatic_routing_enabled": False,
        "official_scorecard_changed": False,
    }
    immutable = APPROVAL_DIR / (
        f"evaluation-approval-{pipeline_id}-{now:%Y%m%d-%H%M%S}.json"
    )
    write_new(immutable, record)
    write_latest(LATEST_APPROVAL, record)

    if decision == "approved":
        candidate_report = {
            "schema_version": 1,
            "source_decision_id": decision_id,
            "source_pipeline_id": pipeline_id,
            "created_at": now.isoformat(),
            "human_approved": True,
            "candidates": candidates,
            "official_scorecard_updated": False,
            "production_model_changed": False,
            "automatic_routing_enabled": False,
        }
        write_latest(LATEST_CANDIDATES, candidate_report)

    print("Human decision recorded:", decision)
    print("Decision ID:", decision_id)
    print("Approved scorecard candidates:", len(record["approved_scorecard_candidates"]))
    print("Production model changed: no")
    print("Automatic routing enabled: no")
    print("Official scorecard changed: no")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Approval operation failed: {exc}", file=sys.stderr)
        raise SystemExit(1)

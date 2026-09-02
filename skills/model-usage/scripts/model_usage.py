#!/usr/bin/env python3
"""
Summarize CodexBar local cost usage by model.

Defaults to current model (most recent daily entry), or list all models.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from typing import Any, Dict, Iterable, List, Optional, Tuple


def positive_int(value: str) -> int:
    try:
        parsed = int(value)
    except ValueError as exc:
        raise argparse.ArgumentTypeError("must be an integer") from exc
    if parsed < 1:
        raise argparse.ArgumentTypeError("must be >= 1")
    return parsed


def eprint(msg: str) -> None:
    print(msg, file=sys.stderr)


def run_codexbar_cost(provider: str) -> List[Dict[str, Any]]:
    cmd = ["codexbar", "cost", "--format", "json", "--provider", provider]
    try:
        output = subprocess.check_output(cmd, text=True)
    except FileNotFoundError:
        raise RuntimeError("codexbar not found on PATH. Install CodexBar CLI first.")
    except subprocess.CalledProcessError as exc:
        raise RuntimeError(f"codexbar cost failed (exit {exc.returncode}).")
    try:
        payload = json.loads(output)
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Failed to parse codexbar JSON output: {exc}")
    if not isinstance(payload, list):
        raise RuntimeError("Expected codexbar cost JSON array.")
    return payload


def load_payload(input_path: Optional[str], provider: str) -> Dict[str, Any]:
    if input_path:
        if input_path == "-":
            raw = sys.stdin.read()
        else:
            with open(input_path, "r", encoding="utf-8") as handle:
                raw = handle.read()
        data = json.loads(raw)
    else:
        data = run_codexbar_cost(provider)

    if isinstance(data, dict):
        return data

    if isinstance(data, list):
        for entry in data:
            if isinstance(entry, dict) and entry.get("provider") == provider:
                return entry
        raise RuntimeError(f"Provider '{provider}' not found in codexbar payload.")

    raise RuntimeError("Unsupported JSON input format.")


@dataclass
class ModelCost:
    model: str
    cost: float


def parse_daily_entries(payload: Dict[str, Any]) -> List[Dict[str, Any]]:
    daily = payload.get("daily")
    if not daily:
        return []
    if not isinstance(daily, list):
        return []
    return [entry for entry in daily if isinstance(entry, dict)]


def parse_date(value: str) -> Optional[date]:
    try:
        return datetime.strptime(value, "%Y-%m-%d").date()
    except Exception:
        return None


def filter_by_days(entries: List[Dict[str, Any]], days: Optional[int]) -> List[Dict[str, Any]]:
    if not days:
        return entries
    cutoff = date.today() - timedelta(days=days - 1)
    filtered: List[Dict[str, Any]] = []
    for entry in entries:
        day = entry.get("date")
        if not isinstance(day, str):
            continue
        parsed = parse_date(day)
        if parsed and parsed >= cutoff:
            filtered.append(entry)
    return filtered


def coerce_finite_cost(value: Any) -> Optional[float]:
    """Coerce a cost field to a finite float, or None if it is not usable.

    Accepts native numbers and numeric strings (for example "1.75"), since cost
    payloads sometimes serialize numbers as strings. Rejects booleans (they are
    ints in Python but never a valid cost) and non-finite values (NaN/Infinity),
    which would otherwise silently corrupt aggregated totals.
    """
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        number = float(value)
    elif isinstance(value, str):
        try:
            number = float(value.strip())
        except ValueError:
            return None
    else:
        return None
    if not math.isfinite(number):
        return None
    return number


def aggregate_costs(entries: Iterable[Dict[str, Any]]) -> Dict[str, float]:
    totals: Dict[str, float] = {}
    for entry in entries:
        breakdowns = entry.get("modelBreakdowns")
        if not breakdowns:
            continue
        if not isinstance(breakdowns, list):
            continue
        for item in breakdowns:
            if not isinstance(item, dict):
                continue
            model = item.get("modelName")
            if not isinstance(model, str):
                continue
            cost = coerce_finite_cost(item.get("cost"))
            if cost is None:
                continue
            totals[model] = totals.get(model, 0.0) + cost
    return totals


def pick_current_model(entries: List[Dict[str, Any]]) -> Tuple[Optional[str], Optional[str]]:
    if not entries:
        return None, None
    sorted_entries = sorted(
        entries,
        key=lambda entry: entry.get("date") or "",
    )
    for entry in reversed(sorted_entries):
        breakdowns = entry.get("modelBreakdowns")
        if isinstance(breakdowns, list) and breakdowns:
            scored: List[ModelCost] = []
            for item in breakdowns:
                if not isinstance(item, dict):
                    continue
                model = item.get("modelName")
                cost = coerce_finite_cost(item.get("cost"))
                if isinstance(model, str) and cost is not None:
                    scored.append(ModelCost(model=model, cost=cost))
            if scored:
                scored.sort(key=lambda item: item.cost, reverse=True)
                return scored[0].model, entry.get("date") if isinstance(entry.get("date"), str) else None
        models_used = entry.get("modelsUsed")
        if isinstance(models_used, list) and models_used:
            last = models_used[-1]
            if isinstance(last, str):
                return last, entry.get("date") if isinstance(entry.get("date"), str) else None
    return None, None


def usd(value: Optional[float]) -> str:
    if value is None:
        return "—"
    return f"${value:,.2f}"


def latest_day_cost(entries: List[Dict[str, Any]], model: str) -> Tuple[Optional[str], Optional[float]]:
    if not entries:
        return None, None
    sorted_entries = sorted(
        entries,
        key=lambda entry: entry.get("date") or "",
    )
    for entry in reversed(sorted_entries):
        breakdowns = entry.get("modelBreakdowns")
        if not isinstance(breakdowns, list):
            continue
        for item in breakdowns:
            if not isinstance(item, dict):
                continue
            if item.get("modelName") == model:
                cost = coerce_finite_cost(item.get("cost"))
                day = entry.get("date") if isinstance(entry.get("date"), str) else None
                return day, cost
    return None, None


def render_text_current(
    provider: str,
    model: str,
    latest_date: Optional[str],
    total_cost: Optional[float],
    latest_cost: Optional[float],
    latest_cost_date: Optional[str],
    entry_count: int,
) -> str:
    lines = [f"Provider: {provider}", f"Current model: {model}"]
    if latest_date:
        lines.append(f"Latest model date: {latest_date}")
    lines.append(f"Total cost (rows): {usd(total_cost)}")
    if latest_cost_date:
        lines.append(f"Latest day cost: {usd(latest_cost)} ({latest_cost_date})")
    lines.append(f"Daily rows: {entry_count}")
    return "\n".join(lines)


def render_text_all(provider: str, totals: Dict[str, float]) -> str:
    lines = [f"Provider: {provider}", "Models:"]
    for model, cost in sorted(totals.items(), key=lambda item: item[1], reverse=True):
        lines.append(f"- {model}: {usd(cost)}")
    return "\n".join(lines)


def build_json_current(
    provider: str,
    model: str,
    latest_date: Optional[str],
    total_cost: Optional[float],
    latest_cost: Optional[float],
    latest_cost_date: Optional[str],
    entry_count: int,
) -> Dict[str, Any]:
    return {
        "provider": provider,
        "mode": "current",
        "model": model,
        "latestModelDate": latest_date,
        "totalCostUSD": total_cost,
        "latestDayCostUSD": latest_cost,
        "latestDayCostDate": latest_cost_date,
        "dailyRowCount": entry_count,
    }


def build_json_all(provider: str, totals: Dict[str, float]) -> Dict[str, Any]:
    return {
        "provider": provider,
        "mode": "all",
        "models": [
            {"model": model, "totalCostUSD": cost}
            for model, cost in sorted(totals.items(), key=lambda item: item[1], reverse=True)
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Summarize CodexBar model usage from local cost logs.")
    parser.add_argument("--provider", choices=["codex", "claude"], default="codex")
    parser.add_argument("--mode", choices=["current", "all"], default="current")
    parser.add_argument("--model", help="Explicit model name to report instead of auto-current.")
    parser.add_argument("--input", help="Path to codexbar cost JSON (or '-' for stdin).")
    parser.add_argument("--days", type=positive_int, help="Limit to last N days (based on daily rows).")
    parser.add_argument("--format", choices=["text", "json"], default="text")
    parser.add_argument("--pretty", action="store_true", help="Pretty-print JSON output.")

    args = parser.parse_args()

    try:
        payload = load_payload(args.input, args.provider)
    except Exception as exc:
        eprint(str(exc))
        return 1

    entries = parse_daily_entries(payload)
    entries = filter_by_days(entries, args.days)

    if args.mode == "current":
        model = args.model
        latest_date = None
        if not model:
            model, latest_date = pick_current_model(entries)
        if not model:
            eprint("No model data found in codexbar cost payload.")
            return 2
        totals = aggregate_costs(entries)
        total_cost = totals.get(model)
        latest_cost_date, latest_cost = latest_day_cost(entries, model)

        if args.format == "json":
            payload_out = build_json_current(
                provider=args.provider,
                model=model,
                latest_date=latest_date,
                total_cost=total_cost,
                latest_cost=latest_cost,
                latest_cost_date=latest_cost_date,
                entry_count=len(entries),
            )
            indent = 2 if args.pretty else None
            print(json.dumps(payload_out, indent=indent, sort_keys=args.pretty))
        else:
            print(
                render_text_current(
                    provider=args.provider,
                    model=model,
                    latest_date=latest_date,
                    total_cost=total_cost,
                    latest_cost=latest_cost,
                    latest_cost_date=latest_cost_date,
                    entry_count=len(entries),
                )
            )
        return 0

    totals = aggregate_costs(entries)
    if not totals:
        eprint("No model breakdowns found in codexbar cost payload.")
        return 2

    if args.format == "json":
        payload_out = build_json_all(provider=args.provider, totals=totals)
        indent = 2 if args.pretty else None
        print(json.dumps(payload_out, indent=indent, sort_keys=args.pretty))
    else:
        print(render_text_all(provider=args.provider, totals=totals))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

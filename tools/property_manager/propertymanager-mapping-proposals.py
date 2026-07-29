#!/usr/bin/env python3
"""CLI to list, approve, or reject RanchBrain task→asset mapping proposals."""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any

API_BASE = os.environ.get("PROPERTYMANAGER_API_BASE", "http://127.0.0.1:5062").rstrip("/")
API_KEY = os.environ.get("PROPERTYMANAGER_API_KEY", "").strip()
OPERATOR = os.environ.get("PROPERTYMANAGER_OPERATOR_IDENTITY", "cli-operator")


def _headers(*, json_body: bool = False) -> dict[str, str]:
    headers: dict[str, str] = {"X-Operator-Identity": OPERATOR}
    if API_KEY:
        headers["Authorization"] = f"Bearer {API_KEY}"
    if json_body:
        headers["Content-Type"] = "application/json"
    return headers


def _request(method: str, path: str, body: dict | None = None) -> tuple[int, Any]:
    url = API_BASE + path
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=_headers(json_body=body is not None), method=method)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            payload = resp.read().decode()
            return resp.status, json.loads(payload) if payload else None
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode(errors="replace")
        try:
            return exc.code, json.loads(raw)
        except json.JSONDecodeError:
            return exc.code, raw


def cmd_list(args: argparse.Namespace) -> int:
    status, payload = _request("GET", f"/v1/mapping-proposals?status={args.status}")
    if status >= 400:
        print(json.dumps(payload, indent=2), file=sys.stderr)
        return 1
    rows = payload if isinstance(payload, list) else []
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    if not rows:
        print(f"No {args.status} mapping proposals.")
        return 0
    for row in rows:
        print(
            f"{row.get('id')}  conf={row.get('confidence')}  "
            f"task={row.get('task_item') or row.get('ranchbrain_task_ref')}  "
            f"asset={row.get('asset_name')} ({row.get('asset_external_id')})  "
            f"rationale={row.get('match_rationale')}"
        )
    return 0


def cmd_approve(args: argparse.Namespace) -> int:
    status, payload = _request("POST", f"/v1/mapping-proposals/{args.proposal_id}/approve", {})
    print(json.dumps(payload, indent=2))
    return 0 if status < 400 else 1


def cmd_reject(args: argparse.Namespace) -> int:
    status, payload = _request("POST", f"/v1/mapping-proposals/{args.proposal_id}/reject", {})
    print(json.dumps(payload, indent=2))
    return 0 if status < 400 else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    list_p = sub.add_parser("list", help="List mapping proposals")
    list_p.add_argument("--status", default="pending", choices=["pending", "approved", "rejected", "all"])
    list_p.add_argument("--json", action="store_true")
    list_p.set_defaults(func=cmd_list)

    approve_p = sub.add_parser("approve", help="Approve a mapping proposal")
    approve_p.add_argument("proposal_id")
    approve_p.set_defaults(func=cmd_approve)

    reject_p = sub.add_parser("reject", help="Reject a mapping proposal")
    reject_p.add_argument("proposal_id")
    reject_p.set_defaults(func=cmd_reject)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())

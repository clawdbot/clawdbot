#!/usr/bin/env python3
"""Generate QR code PNG labels for PropertyManager assets.

Usage:
  python3 tools/property_manager/generate_asset_qr.py --api http://127.0.0.1:5062 --out /tmp/asset-qr
  python3 tools/property_manager/generate_asset_qr.py --dashboard-base http://100.85.36.72:5000
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import urllib.request
from pathlib import Path


def fetch_assets(api_base: str) -> list[dict]:
    url = api_base.rstrip("/") + "/assets"
    with urllib.request.urlopen(url, timeout=30) as resp:
        payload = json.loads(resp.read().decode())
    if not isinstance(payload, list):
        raise RuntimeError("Expected list from /assets")
    return payload


def qr_png(url: str, out_path: Path) -> None:
    try:
        import qrcode
    except ImportError:
        raise SystemExit("Install qrcode: pip install qrcode[pil]")

    img = qrcode.make(url)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    img.save(out_path)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--api", default="http://127.0.0.1:5062", help="PropertyManager API base URL")
    parser.add_argument(
        "--dashboard-base",
        default="http://100.85.36.72:5000",
        help="Dashboard base URL encoded in QR codes",
    )
    parser.add_argument("--out", type=Path, default=Path("reports/asset-qr"), help="Output directory")
    parser.add_argument("--meter-only", action="store_true", help="Skip assets with meter_type=none")
    args = parser.parse_args()

    assets = fetch_assets(args.api)
    generated = 0
    for asset in assets:
        meter = asset.get("meter") or {}
        meter_type = meter.get("meter_type") or "none"
        if args.meter_only and meter_type == "none":
            continue
        qr_token = asset.get("qr_token")
        if not qr_token:
            continue
        name = str(asset.get("name") or asset.get("external_id") or "asset")
        slug = "".join(c if c.isalnum() else "-" for c in name).strip("-")[:40] or "asset"
        page_url = args.dashboard_base.rstrip("/") + f"/pm/asset/{qr_token}"
        out_file = args.out / f"{slug}-{qr_token[:8]}.png"
        qr_png(page_url, out_file)
        print(f"{name}: {page_url} -> {out_file}")
        generated += 1

    print(f"Generated {generated} QR label(s) in {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

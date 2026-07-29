#!/usr/bin/env python3
"""Patch iPhone PropertyAPIClient for meter completion."""

from __future__ import annotations

import sys
from pathlib import Path

API = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "ai/projects/openclaw/apps/propertymanager-ios/Sources/PropertyAPIClient.swift")


def main() -> None:
    text = API.read_text(encoding="utf-8")
    old = "    func completeTask(id: UUID, note: String?) async throws -> MaintenanceTask {"
    new = "    func completeTask(id: UUID, note: String?, meterValueAtCompletion: Double? = nil) async throws -> MaintenanceTask {"
    if old not in text and new in text:
        print("already patched")
        return
    if old not in text:
        raise SystemExit("completeTask anchor missing")
    text = text.replace(old, new, 1)
    text = text.replace(
        '        let body: [String: String] = ["note": note ?? ""]\n        request.httpBody = try JSONSerialization.data(withJSONObject: body)',
        '        var body: [String: Any] = ["note": note ?? ""]\n        if let meterValueAtCompletion { body["meter_value_at_completion"] = meterValueAtCompletion }\n        request.httpBody = try JSONSerialization.data(withJSONObject: body)',
        1,
    )
    API.write_text(text, encoding="utf-8")
    print("patched iOS PropertyAPIClient")


if __name__ == "__main__":
    main()

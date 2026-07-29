#!/usr/bin/env python3
"""Apply operating-meter patches to Mac PropertyManagerApp on M4."""

from __future__ import annotations

import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]
SWIFT_MAC = REPO_ROOT / "tools/property_manager/swift-mac"
ROOT = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / "Development/PropertyManagerApp")
APP = ROOT / "Sources/PropertyManagerApp/PropertyManagerApp.swift"
API = ROOT / "Sources/PropertyManagerApp/PropertyAPIClient.swift"
MANUAL = ROOT / "Sources/PropertyManagerApp/ManualImport.swift"
ASSET_API = ROOT / "Sources/PropertyManagerApp/AssetAPIClient.swift"
ASSET_VIEWS = ROOT / "Sources/PropertyManagerApp/AssetViews.swift"


def patch_file(path: Path, old: str, new: str, label: str) -> None:
    text = path.read_text(encoding="utf-8")
    if old not in text:
        if new.split("\n", 1)[0].strip() in text:
            print(f"skip (already patched): {label}")
            return
        raise SystemExit(f"patch anchor not found: {label}")
    path.write_text(text.replace(old, new, 1), encoding="utf-8")
    print(f"patched: {label}")


def copy_swift_mac_files() -> None:
    for src, dest in (
        (SWIFT_MAC / "AssetAPIClient.swift", ASSET_API),
        (SWIFT_MAC / "AssetViews.swift", ASSET_VIEWS),
    ):
        if not src.is_file():
            raise SystemExit(f"missing repo file: {src}")
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(src.read_text(encoding="utf-8"), encoding="utf-8")
        print(f"copied: {src.name} -> {dest}")


def main() -> None:
    copy_swift_mac_files()
    patch_file(
        APP,
        "    var manualImport: ManualURLImportRecord?\n\n    enum CodingKeys",
        "    var manualImport: ManualURLImportRecord?\n    var scheduleKind: String = \"calendar\"\n    var meterIntervalValue: Double? = nil\n    var meterIntervalUnit: String? = nil\n    var assetId: UUID? = nil\n\n    enum CodingKeys",
        "MaintenanceTask meter fields",
    )
    patch_file(
        APP,
        "        case manualImport\n    }",
        "        case manualImport\n        case scheduleKind, meterIntervalValue, meterIntervalUnit, assetId\n    }",
        "MaintenanceTask CodingKeys",
    )
    patch_file(
        APP,
        "        manualImport: ManualURLImportRecord? = nil\n    ) {",
        "        manualImport: ManualURLImportRecord? = nil,\n        scheduleKind: String = \"calendar\",\n        meterIntervalValue: Double? = nil,\n        meterIntervalUnit: String? = nil,\n        assetId: UUID? = nil\n    ) {",
        "MaintenanceTask init signature",
    )
    patch_file(
        APP,
        "        self.manualImport = manualImport\n    }",
        "        self.manualImport = manualImport\n        self.scheduleKind = scheduleKind\n        self.meterIntervalValue = meterIntervalValue\n        self.meterIntervalUnit = meterIntervalUnit\n        self.assetId = assetId\n    }",
        "MaintenanceTask init body",
    )
    patch_file(
        APP,
        "    @Published var lastPublishAt: Date?\n\n    private let apiBaseURLKey",
        "    @Published var lastPublishAt: Date?\n    @Published var assets: [MacRanchAsset] = []\n    @Published var showAssetsPanel: Bool = false\n\n    private let apiBaseURLKey",
        "MaintenanceStore assets state",
    )
    patch_file(
        APP,
        "    private var apiClient: PropertyAPIClient {",
        "    var apiClient: PropertyAPIClient {",
        "MaintenanceStore public apiClient",
    )
    patch_file(
        APP,
        "    func refreshFromServer() async {",
        "    func refreshAssets() async {\n        do {\n            assets = try await apiClient.fetchAssets()\n        } catch {\n            statusMessage = \"Couldn’t load assets: \\(error.localizedDescription)\"\n        }\n    }\n\n    func refreshFromServer() async {",
        "MaintenanceStore refreshAssets",
    )
    patch_file(
        APP,
        "        .task {\n            await store.refreshFromServer()\n        }",
        "        .task {\n            await store.refreshFromServer()\n            await store.refreshAssets()\n        }",
        "ContentView refresh assets",
    )
    patch_file(
        APP,
        "            VStack(spacing: 0) {\n                TaskListHeaderView(",
        "            Group {\n            if store.showAssetsPanel {\n                MacAssetsPanel(store: store)\n            } else {\n            VStack(spacing: 0) {\n                TaskListHeaderView(",
        "ContentView assets panel branch",
    )
    patch_file(
        APP,
        "            .frame(width: 330)\n\n            Divider()\n\n            editorArea",
        "            .frame(width: 330)\n            }\n            }\n\n            Divider()\n\n            editorArea",
        "ContentView close assets branch",
    )
    patch_file(
        APP,
        "                ActionResultView(message: statusMessage)\n            }\n            .padding(10)",
        "                ActionResultView(message: statusMessage)\n\n                Button {\n                    store.showAssetsPanel.toggle()\n                } label: {\n                    Label(store.showAssetsPanel ? \"Show Tasks\" : \"Show Assets\", systemImage: \"gauge.with.dots.needle.67percent\")\n                        .frame(maxWidth: .infinity, alignment: .leading)\n                }\n                .buttonStyle(.bordered)\n            }\n            .padding(10)",
        "Sidebar assets toggle",
    )
    patch_file(
        API,
        "    func completeTask(id: UUID, note: String?) async throws -> MaintenanceTask {",
        "    func completeTask(id: UUID, note: String?, meterValueAtCompletion: Double? = nil) async throws -> MaintenanceTask {",
        "completeTask signature",
    )
    patch_file(
        API,
        "        request.httpBody = try JSONSerialization.data(withJSONObject: [\"note\": note ?? \"\"])",
        "        var completeBody: [String: Any] = [\"note\": note ?? \"\"]\n        if let meterValueAtCompletion { completeBody[\"meter_value_at_completion\"] = meterValueAtCompletion }\n        request.httpBody = try JSONSerialization.data(withJSONObject: completeBody)",
        "completeTask body meter",
    )
    patch_file(
        API,
        "            \"parts\": task.parts.enumerated().map { index, part -> [String: Any] in",
        "            \"schedule_kind\": task.scheduleKind,\n            \"meter_interval_value\": task.meterIntervalValue as Any,\n            \"meter_interval_unit\": task.meterIntervalUnit as Any,\n            \"asset_id\": task.assetId?.uuidString as Any,\n            \"parts\": task.parts.enumerated().map { index, part -> [String: Any] in",
        "APITaskDTO payload meter fields",
    )
    patch_file(
        MANUAL,
        "    var verificationStatus: ManualVerificationStatus = .unverified\n\n    func asMaintenanceTask(",
        "    var verificationStatus: ManualVerificationStatus = .unverified\n    var meterIntervalValue: Double? = nil\n    var meterIntervalUnit: String? = nil\n\n    func asMaintenanceTask(",
        "ManualImportDraft meter fields",
    )
    patch_file(
        MANUAL,
        "        return MaintenanceTask(\n            area: area,\n            item: item,\n            category: category,\n            priority: .medium,\n            frequency: frequency,",
        "        let scheduleKind = meterIntervalValue != nil ? \"meter\" : \"calendar\"\n        return MaintenanceTask(\n            area: area,\n            item: item,\n            category: category,\n            priority: .medium,\n            frequency: frequency,",
        "ManualImportDraft schedule kind",
    )
    patch_file(
        MANUAL,
        "            manualImport: record\n        )\n    }\n}\n\nenum ManualImportError",
        "            manualImport: record,\n            scheduleKind: scheduleKind,\n            meterIntervalValue: meterIntervalValue,\n            meterIntervalUnit: meterIntervalUnit\n        )\n    }\n}\n\nenum ManualImportError",
        "ManualImportDraft task meter args",
    )

    manual_text = MANUAL.read_text(encoding="utf-8")
    if "meterIntervalValue" not in manual_text.split("warningDays", 1)[0]:
        manual_text = manual_text.replace(
            '"warningDays": ["type": "integer"],',
            '"warningDays": ["type": "integer"],\n                "meterIntervalValue": ["type": "number"],\n                "meterIntervalUnit": ["type": "string"],',
        )
    if "draft.meterIntervalValue" not in manual_text:
        manual_text = manual_text.replace(
            "                    warningDays: warning,",
            "                    meterIntervalValue: task.meterIntervalValue,\n                    meterIntervalUnit: task.meterIntervalUnit,\n                    warningDays: warning,",
        )
    MANUAL.write_text(manual_text, encoding="utf-8")
    print("patched: ManualImport LLM schema + draft mapping")

    # Phase 2: /v1/ makeURL + confirm_current_meter
    api_text = API.read_text(encoding="utf-8")
    if "versioned: Bool" not in api_text and "func makeURL(_ path: String)" in api_text:
        api_text = api_text.replace(
            "    func makeURL(_ path: String) throws -> URL {",
            "    func makeURL(_ path: String, versioned: Bool = false) throws -> URL {\n"
            "        let prefix = versioned ? \"/v1\" : \"\"\n"
            "        let normalized = path.hasPrefix(\"/\") ? path : \"/\\(path)\"",
            1,
        )
        api_text = api_text.replace(
            '        guard let url = URL(string: baseURLString + path) else {',
            '        guard let url = URL(string: baseURLString + prefix + normalized) else {',
            1,
        )
        API.write_text(api_text, encoding="utf-8")
        print("patched: makeURL versioned /v1/ prefix")
    else:
        print("skip (already patched): makeURL versioned")

    api_text = API.read_text(encoding="utf-8")
    if "confirmCurrentMeter" not in api_text and "meterValueAtCompletion" in api_text:
        api_text = api_text.replace(
            "meterValueAtCompletion: Double? = nil) async throws -> MaintenanceTask {",
            "meterValueAtCompletion: Double? = nil, confirmCurrentMeter: Bool = false) async throws -> MaintenanceTask {",
            1,
        )
        api_text = api_text.replace(
            'if let meterValueAtCompletion { completeBody["meter_value_at_completion"] = meterValueAtCompletion }',
            'if let meterValueAtCompletion { completeBody["meter_value_at_completion"] = meterValueAtCompletion }\n        else if confirmCurrentMeter { completeBody["confirm_current_meter"] = true }',
            1,
        )
        API.write_text(api_text, encoding="utf-8")
        print("patched: completeTask confirm_current_meter")

    print("done")


if __name__ == "__main__":
    main()

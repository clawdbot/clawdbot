import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { applySlotSelectionForPlugin } from "../plugins/slot-selection.js";

const loadPluginMetadataSnapshotMock = vi.fn();
const buildPluginDiagnosticsReportMock = vi.fn();

vi.mock("../plugins/plugin-metadata-snapshot.js", () => ({
  loadPluginMetadataSnapshot: (...args: unknown[]) => loadPluginMetadataSnapshotMock(...args),
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginDiagnosticsReport: (...args: unknown[]) => buildPluginDiagnosticsReportMock(...args),
}));

describe("applySlotSelectionForPlugin", () => {
  beforeEach(() => {
    loadPluginMetadataSnapshotMock.mockReset();
    buildPluginDiagnosticsReportMock.mockReset();
  });

  it("leaves an existing legacy memory selector for doctor when install selects recall", () => {
    const config: OpenClawConfig = {
      plugins: {
        slots: { memory: "legacy-memory" },
        entries: {
          "legacy-memory": { enabled: true },
          "new-recall": { enabled: true },
        },
      },
    };
    loadPluginMetadataSnapshotMock.mockReturnValue({
      plugins: [{ id: "new-recall", kind: "memory" }],
    });

    const result = applySlotSelectionForPlugin(config, "new-recall");

    expect(result.config.plugins?.slots?.memory).toBe("legacy-memory");
    expect(result.config.plugins?.slots?.["memory.recall"]).toBe("new-recall");
    expect(result.config.plugins?.entries?.["legacy-memory"]?.enabled).toBe(true);
    expect(result.warnings).toEqual([
      'Exclusive slot "memory.recall" switched from "memory-core" to "new-recall".',
    ]);
    expect(buildPluginDiagnosticsReportMock).not.toHaveBeenCalled();
  });
});

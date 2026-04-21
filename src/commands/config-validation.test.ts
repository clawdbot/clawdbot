import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginCompatibilityNotice } from "../plugins/status.js";
import { createCompatibilityNotice } from "../plugins/status.test-helpers.js";
import { requireValidConfigSnapshot } from "./config-validation.js";

const { readConfigFileSnapshot, buildPluginCompatibilitySnapshotNotices } = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  buildPluginCompatibilitySnapshotNotices: vi.fn<
    (_params?: unknown) => PluginCompatibilityNotice[]
  >(() => []),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot,
}));

vi.mock("../plugins/status.js", () => ({
  buildPluginCompatibilitySnapshotNotices,
  formatPluginCompatibilityNotice: (notice: { pluginId: string; message: string }) =>
    `${notice.pluginId} ${notice.message}`,
}));

describe("requireValidConfigSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function createValidSnapshot() {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: true,
      config: { plugins: {} },
      issues: [],
    });
    buildPluginCompatibilitySnapshotNotices.mockReturnValue([
      createCompatibilityNotice({ pluginId: "legacy-plugin", code: "legacy-before-agent-start" }),
    ]);
  }

  function createRuntime() {
    return {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn(),
    };
  }

  it("returns config without emitting compatibility advice by default", async () => {
    createValidSnapshot();
    const runtime = createRuntime();

    const config = await requireValidConfigSnapshot(runtime);

    expect(config).toEqual({ plugins: {} });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(buildPluginCompatibilitySnapshotNotices).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("emits a non-blocking compatibility advisory when explicitly requested", async () => {
    createValidSnapshot();
    const runtime = createRuntime();

    const config = await requireValidConfigSnapshot(runtime, {
      includeCompatibilityAdvisory: true,
    });

    expect(config).toEqual({ plugins: {} });
    expect(runtime.error).not.toHaveBeenCalled();
    expect(runtime.exit).not.toHaveBeenCalled();
    expect(String(runtime.log.mock.calls[0]?.[0])).toContain("Plugin compatibility: 1 notice.");
    expect(String(runtime.log.mock.calls[0]?.[0])).toContain(
      "legacy-plugin still uses legacy before_agent_start",
    );
  });

  it("blocks invalid config before emitting compatibility advice", async () => {
    readConfigFileSnapshot.mockResolvedValue({
      exists: true,
      valid: false,
      config: {},
      issues: [{ path: "routing.allowFrom", message: "Legacy key" }],
    });
    const runtime = createRuntime();

    const config = await requireValidConfigSnapshot(runtime, {
      includeCompatibilityAdvisory: true,
    });

    expect(config).toBeNull();
    expect(runtime.error).toHaveBeenCalled();
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });
});

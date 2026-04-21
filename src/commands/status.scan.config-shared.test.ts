import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadStatusScanCommandConfig,
  resolveStatusScanColdStart,
  shouldSkipStatusScanMissingConfigFastPath,
} from "./status.scan.config-shared.js";

const mocks = vi.hoisted(() => ({
  resolveConfigPath: vi.fn(),
}));

vi.mock("../config/paths.js", () => ({
  resolveConfigPath: mocks.resolveConfigPath,
}));

describe("status.scan.config-shared", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveConfigPath.mockReturnValue(
      `/tmp/openclaw-status-scan-config-shared-missing-${process.pid}.json`,
    );
  });

  it("detects the test fast-path env toggle", () => {
    expect(shouldSkipStatusScanMissingConfigFastPath({ ...process.env, VITEST: "true" })).toBe(
      true,
    );
    expect(shouldSkipStatusScanMissingConfigFastPath({ ...process.env, NODE_ENV: "test" })).toBe(
      true,
    );
    expect(shouldSkipStatusScanMissingConfigFastPath({})).toBe(false);
  });

  it("treats missing config as cold-start when fast-path bypass is disabled", () => {
    expect(resolveStatusScanColdStart({ env: {}, allowMissingConfigFastPath: false })).toBe(true);
  });

  it("skips read/resolve on fast-json cold-start outside tests", async () => {
    const readBestEffortConfig = vi.fn(async () => ({ channels: { quietchat: {} } }));
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig: { channels: { quietchat: {} } },
      diagnostics: ["resolved"],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readBestEffortConfig,
      resolveConfig,
      env: {},
      allowMissingConfigFastPath: true,
    });

    expect(readBestEffortConfig).not.toHaveBeenCalled();
    expect(resolveConfig).not.toHaveBeenCalled();
    expect(result).toEqual({
      coldStart: true,
      sourceConfig: {},
      resolvedConfig: {},
      secretDiagnostics: [],
    });
  });

  it("still reads and resolves during tests even when the config path is missing", async () => {
    const sourceConfig = { channels: { quietchat: {} } };
    const resolvedConfig = { channels: { quietchat: {} } };
    const readBestEffortConfig = vi.fn(async () => sourceConfig);
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig,
      diagnostics: ["resolved"],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readBestEffortConfig,
      resolveConfig,
      env: { VITEST: "true" },
      allowMissingConfigFastPath: true,
    });

    expect(readBestEffortConfig).toHaveBeenCalled();
    expect(resolveConfig).toHaveBeenCalledWith(sourceConfig);
    expect(result).toEqual({
      coldStart: false,
      sourceConfig,
      resolvedConfig,
      secretDiagnostics: ["resolved"],
    });
  });
});

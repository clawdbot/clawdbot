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

  it("adds a status diagnostic for gateway token source conflicts", async () => {
    const sourceConfig = { gateway: { auth: { token: "config-token" } } };
    const resolvedConfig = sourceConfig;
    const readBestEffortConfig = vi.fn(async () => sourceConfig);
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig,
      diagnostics: [],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readBestEffortConfig,
      resolveConfig,
      env: { VITEST: "true", OPENCLAW_GATEWAY_TOKEN: "env-token" },
      allowMissingConfigFastPath: true,
    });

    expect(result.secretDiagnostics).toEqual([
      expect.stringContaining("OPENCLAW_GATEWAY_TOKEN conflicts with gateway.auth.token"),
    ]);
  });

  it("does not add a token conflict diagnostic inside the managed gateway service context", async () => {
    const sourceConfig = { gateway: { auth: { token: "config-token" } } };
    const readBestEffortConfig = vi.fn(async () => sourceConfig);
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig: sourceConfig,
      diagnostics: [],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readBestEffortConfig,
      resolveConfig,
      env: {
        VITEST: "true",
        OPENCLAW_GATEWAY_TOKEN: "env-token",
        OPENCLAW_SERVICE_KIND: "gateway",
      },
      allowMissingConfigFastPath: true,
    });

    expect(result.secretDiagnostics).toStrictEqual([]);
  });

  it("does not add a status diagnostic when config uses OPENCLAW_GATEWAY_TOKEN", async () => {
    const sourceConfig = {
      gateway: { auth: { token: "${OPENCLAW_GATEWAY_TOKEN}" } },
      secrets: { providers: { default: { source: "env" as const } } },
    };
    const readBestEffortConfig = vi.fn(async () => sourceConfig);
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig: sourceConfig,
      diagnostics: [],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readBestEffortConfig,
      resolveConfig,
      env: { VITEST: "true", OPENCLAW_GATEWAY_TOKEN: "env-token" },
      allowMissingConfigFastPath: true,
    });

    expect(result.secretDiagnostics).toStrictEqual([]);
  });

  it("does not add a status diagnostic for remote gateway mode", async () => {
    const sourceConfig = {
      gateway: {
        mode: "remote" as const,
        remote: { token: "remote-token" },
        auth: { token: "local-token" },
      },
    };
    const readBestEffortConfig = vi.fn(async () => sourceConfig);
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig: sourceConfig,
      diagnostics: [],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readBestEffortConfig,
      resolveConfig,
      env: { VITEST: "true", OPENCLAW_GATEWAY_TOKEN: "env-token" },
      allowMissingConfigFastPath: true,
    });

    expect(result.secretDiagnostics).toStrictEqual([]);
  });
});

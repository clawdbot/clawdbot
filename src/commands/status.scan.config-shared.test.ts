// Status scan config tests cover scan command config loading and cold-start resolution.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadStatusScanCommandConfig } from "./status.scan.config-shared.js";

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

  it("skips read/resolve on fast-json cold-start outside tests", async () => {
    const readConfigSnapshot = vi.fn(async () => ({
      config: { channels: { quietchat: {} } },
      sourceConfig: { channels: { quietchat: {} } },
    }));
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig: { channels: { quietchat: {} } },
      diagnostics: ["resolved"],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readConfigSnapshot,
      resolveConfig,
      env: {},
      allowMissingConfigFastPath: true,
    });

    expect(readConfigSnapshot).not.toHaveBeenCalled();
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
    const readConfigSnapshot = vi.fn(async () => ({
      config: sourceConfig,
      sourceConfig,
    }));
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig,
      diagnostics: ["resolved"],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readConfigSnapshot,
      resolveConfig,
      env: { VITEST: "true" },
      allowMissingConfigFastPath: true,
    });

    expect(readConfigSnapshot).toHaveBeenCalled();
    expect(resolveConfig).toHaveBeenCalledWith(sourceConfig);
    expect(result).toEqual({
      coldStart: false,
      sourceConfig,
      resolvedConfig,
      secretDiagnostics: ["resolved"],
    });
  });

  it("keeps raw source config separate from materialized resolution input", async () => {
    const loadedConfig = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [{ id: "claude-sonnet-4-6", contextWindow: 200_000 }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const sourceConfig = {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            models: [{ id: "claude-sonnet-4-6" }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolvedConfig = structuredClone(loadedConfig);
    const resolveConfig = vi.fn(async () => ({ resolvedConfig, diagnostics: [] }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status",
      readConfigSnapshot: async () => ({ config: loadedConfig, sourceConfig }),
      resolveConfig,
      env: { VITEST: "true" },
    });

    expect(resolveConfig).toHaveBeenCalledWith(loadedConfig);
    expect(result.sourceConfig).toBe(sourceConfig);
    expect(result.resolvedConfig).toBe(resolvedConfig);
  });

  it("adds a status diagnostic for gateway token source conflicts", async () => {
    const sourceConfig = { gateway: { auth: { token: "config-token" } } };
    const resolvedConfig = sourceConfig;
    const readConfigSnapshot = vi.fn(async () => ({
      config: sourceConfig,
      sourceConfig,
    }));
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig,
      diagnostics: [],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readConfigSnapshot,
      resolveConfig,
      env: { VITEST: "true", OPENCLAW_GATEWAY_TOKEN: "env-token" },
      allowMissingConfigFastPath: true,
    });

    expect(result.secretDiagnostics).toEqual([
      "OPENCLAW_GATEWAY_TOKEN conflicts with gateway.auth.token: Remove OPENCLAW_GATEWAY_TOKEN from the shell, ~/.openclaw/.env, or launchctl env if gateway.auth.token is intended, or point gateway.auth.token at ${OPENCLAW_GATEWAY_TOKEN} if the env var should be canonical.",
    ]);
  });

  it("does not add a token conflict diagnostic inside the managed gateway service context", async () => {
    const sourceConfig = { gateway: { auth: { token: "config-token" } } };
    const readConfigSnapshot = vi.fn(async () => ({
      config: sourceConfig,
      sourceConfig,
    }));
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig: sourceConfig,
      diagnostics: [],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readConfigSnapshot,
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
    const readConfigSnapshot = vi.fn(async () => ({
      config: sourceConfig,
      sourceConfig,
    }));
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig: sourceConfig,
      diagnostics: [],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readConfigSnapshot,
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
    const readConfigSnapshot = vi.fn(async () => ({
      config: sourceConfig,
      sourceConfig,
    }));
    const resolveConfig = vi.fn(async () => ({
      resolvedConfig: sourceConfig,
      diagnostics: [],
    }));

    const result = await loadStatusScanCommandConfig({
      commandName: "status --json",
      readConfigSnapshot,
      resolveConfig,
      env: { VITEST: "true", OPENCLAW_GATEWAY_TOKEN: "env-token" },
      allowMissingConfigFastPath: true,
    });

    expect(result.secretDiagnostics).toStrictEqual([]);
  });
});

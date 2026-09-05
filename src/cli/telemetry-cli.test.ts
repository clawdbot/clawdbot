import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { registerTelemetryCli } from "./telemetry-cli.js";

const mocks = await vi.hoisted(async () => {
  const { createCliRuntimeMock } = await import("./test-runtime-mock.js");
  return {
    ...createCliRuntimeMock(vi),
    getRuntimeConfig: vi.fn(),
    transformConfigFileWithRetry: vi.fn(),
    buildTelemetryPayload: vi.fn(),
    buildTelemetryUserAgent: vi.fn(),
    resolveTelemetryStatus: vi.fn(),
  };
});

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  transformConfigFileWithRetry: mocks.transformConfigFileWithRetry,
}));
vi.mock("../infra/telemetry.js", () => ({
  buildTelemetryPayload: mocks.buildTelemetryPayload,
  buildTelemetryUserAgent: mocks.buildTelemetryUserAgent,
  resolveTelemetryStatus: mocks.resolveTelemetryStatus,
}));
vi.mock("../runtime.js", () => ({ defaultRuntime: mocks.defaultRuntime }));

const config: OpenClawConfig = {
  telemetry: { enabled: true, consentedAt: "2026-08-23T00:00:00.000Z" },
};
const payload = {
  schema: 1,
  version: "2026.8.2",
  platform: "darwin-arm64",
  node: "26.0.1",
  surface: "gateway",
  features: {
    channels: ["discord", "telegram"],
    providerFamilies: ["anthropic", "openai"],
    pluginsEnabled: 7,
    sessionsLast24h: 14,
  },
};

async function runTelemetryCli(args: string[]): Promise<void> {
  const program = new Command().exitOverride();
  registerTelemetryCli(program);
  await program.parseAsync(["telemetry", ...args], { from: "user" });
}

describe("telemetry cli", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.runtimeLogs.length = 0;
    mocks.runtimeErrors.length = 0;
    mocks.defaultRuntime.writeJson.mockImplementation(() => {});
    mocks.getRuntimeConfig.mockReturnValue(config);
    mocks.buildTelemetryPayload.mockReturnValue(payload);
    mocks.buildTelemetryUserAgent.mockReturnValue(
      "openclaw/2026.8.2 (darwin; node/26.0.1; arm64; gateway)",
    );
    mocks.resolveTelemetryStatus.mockReturnValue({
      enabled: true,
      reason: "enabled",
      endpoint: "https://telemetry.openclaw.ai/api/latest-version",
      lastPingAt: Date.parse("2026-08-22T12:00:00.000Z"),
    });
  });

  it("prints exactly the canonical payload when feature statistics are enabled", async () => {
    await runTelemetryCli(["show"]);

    expect(mocks.buildTelemetryPayload).toHaveBeenCalledWith(config, { surface: "gateway" });
    expect(mocks.runtimeLogs).toContain(JSON.stringify(payload));
    expect(mocks.runtimeLogs).toContain("Feature stats: enabled");
    expect(mocks.runtimeLogs).toContain("Last ping: 2026-08-22T12:00:00.000Z");
    expect(mocks.runtimeLogs).toContain(
      "Request: POST https://telemetry.openclaw.ai/api/latest-version",
    );
  });

  it("reports the same state and canonical payload as one JSON document", async () => {
    await runTelemetryCli(["show", "--json"]);

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
      {
        featureStatsEnabled: true,
        reason: "enabled",
        endpoint: "https://telemetry.openclaw.ai/api/latest-version",
        lastPingAt: "2026-08-22T12:00:00.000Z",
        request: {
          method: "POST",
          userAgent: "openclaw/2026.8.2 (darwin; node/26.0.1; arm64; gateway)",
          payload,
        },
      },
      0,
    );
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
  });

  it.each([
    { reason: "never-asked", label: "consent has not been requested", method: "GET" },
    { reason: "config-disabled", label: "disabled in configuration", method: "GET" },
    { reason: "do-not-track", label: "disabled by DO_NOT_TRACK", method: "GET" },
    { reason: "update-disabled", label: "update checks are disabled", method: null },
    {
      reason: "automated-environment",
      label: "disabled in an automated environment (CI is set)",
      method: null,
    },
  ])("reports the same request in JSON and text for $reason", async ({ reason, label, method }) => {
    const endpoint = "https://telemetry.openclaw.ai/api/latest-version";
    const userAgent = "openclaw/2026.8.2 (darwin; node/26.0.1; arm64; gateway)";
    mocks.resolveTelemetryStatus.mockReturnValue({
      enabled: false,
      reason,
      endpoint,
    });

    await runTelemetryCli(["show", "--json"]);

    expect(mocks.defaultRuntime.writeJson).toHaveBeenCalledExactlyOnceWith(
      {
        featureStatsEnabled: false,
        reason,
        endpoint,
        lastPingAt: null,
        request: method ? { method, userAgent } : null,
      },
      0,
    );
    expect(mocks.defaultRuntime.log).not.toHaveBeenCalled();
    await runTelemetryCli(["show"]);

    expect(mocks.buildTelemetryPayload).not.toHaveBeenCalled();
    expect(mocks.runtimeLogs).toEqual([
      "Feature stats: disabled",
      `Reason: ${label}`,
      `Endpoint: ${endpoint}`,
      "Last ping: never",
      ...(method
        ? [`Request: ${method} ${endpoint}`, `User-Agent: ${userAgent}`]
        : [`Request: none (${label})`]),
    ]);
  });

  it.each([
    { command: "on", enabled: true },
    { command: "off", enabled: false },
  ])(
    "records operator consent when turning feature statistics $command",
    async ({ command, enabled }) => {
      const originalConfig: OpenClawConfig = {
        update: { checkOnStart: false },
        telemetry: { enabled: !enabled, consentedAt: "2025-01-01T00:00:00.000Z" },
      };
      mocks.transformConfigFileWithRetry.mockImplementationOnce(
        async (options: {
          transform: (current: OpenClawConfig) => { nextConfig: OpenClawConfig };
        }) => options.transform(originalConfig),
      );

      await runTelemetryCli([command]);

      const result = await mocks.transformConfigFileWithRetry.mock.results[0]?.value;
      expect(result.nextConfig).toMatchObject({
        update: { checkOnStart: false },
        telemetry: { enabled, consentedAt: expect.any(String) },
      });
      expect(Number.isNaN(Date.parse(result.nextConfig.telemetry.consentedAt))).toBe(false);
      expect(mocks.runtimeLogs).toContain(
        `Anonymous feature stats ${enabled ? "enabled" : "disabled"}.`,
      );
    },
  );
});

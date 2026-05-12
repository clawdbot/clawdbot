import { beforeEach, describe, expect, it, vi } from "vitest";
import { VERSION } from "../version.js";
import { resolveStatusUpdateChannelInfo } from "./status-all/format.js";
import { buildStatusJsonPayload } from "./status-json-payload.ts";

const mocks = vi.hoisted(() => ({
  normalizeUpdateChannel: vi.fn((value?: string | null) => value ?? null),
  resolveUpdateChannelDisplay: vi.fn(() => ({
    channel: "stable",
    source: "config",
    label: "stable",
  })),
}));

vi.mock("../infra/update-channels.js", () => ({
  normalizeUpdateChannel: mocks.normalizeUpdateChannel,
  resolveUpdateChannelDisplay: mocks.resolveUpdateChannelDisplay,
}));

describe("status-json-payload", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves update channel info through the shared channel display path", () => {
    expect(
      resolveStatusUpdateChannelInfo({
        updateConfigChannel: "beta",
        update: {
          installKind: "package",
          git: {
            tag: "v1.2.3",
            branch: "main",
          },
        },
      }),
    ).toEqual({
      channel: "stable",
      source: "config",
      label: "stable",
    });
    expect(mocks.normalizeUpdateChannel).toHaveBeenCalledWith("beta");
    expect(mocks.resolveUpdateChannelDisplay).toHaveBeenCalledWith({
      configChannel: "beta",
      currentVersion: VERSION,
      installKind: "package",
      gitTag: "v1.2.3",
      gitBranch: "main",
    });
  });

  it("builds the shared status json payload with optional sections", () => {
    expect(
      buildStatusJsonPayload({
        summary: { ok: true },
        surface: {
          cfg: { update: { channel: "stable" }, gateway: {} },
          update: {
            root: "/tmp/openclaw",
            installKind: "package",
            packageManager: "npm",
            registry: { latestVersion: "1.2.3" },
          } as never,
          tailscaleMode: "serve",
          gatewayMode: "remote",
          remoteUrlMissing: false,
          gatewayConnection: { url: "wss://gateway.example.com", urlSource: "config" },
          gatewayReachable: true,
          gatewayProbe: { connectLatencyMs: 42, error: null },
          gatewayProbeAuth: { token: "tok" },
          gatewaySelf: { host: "gateway" },
          gatewayProbeAuthWarning: "warn",
          gatewayService: { label: "LaunchAgent", installed: true, loadedText: "loaded" },
          nodeService: { label: "node", installed: true, loadedText: "loaded" },
        },
        osSummary: { platform: "linux" },
        memory: null,
        memoryPlugin: { enabled: true },
        agents: [{ id: "main" }],
        secretDiagnostics: ["diag"],
        securityAudit: { summary: { critical: 1 } },
        health: { ok: true },
        usage: { providers: [] },
        lastHeartbeat: { status: "ok" },
        pluginCompatibility: [
          {
            pluginId: "legacy",
            code: "legacy-before-agent-start",
            severity: "warn",
            message: "warn",
          },
        ],
      }),
    ).toEqual({
      ok: true,
      os: { platform: "linux" },
      update: {
        root: "/tmp/openclaw",
        installKind: "package",
        packageManager: "npm",
        registry: { latestVersion: "1.2.3" },
      },
      updateChannel: "stable",
      updateChannelSource: "config",
      memory: null,
      memoryPlugin: { enabled: true },
      gateway: {
        mode: "remote",
        url: "wss://gateway.example.com",
        urlSource: "config",
        misconfigured: false,
        reachable: true,
        connectLatencyMs: 42,
        self: { host: "gateway" },
        error: null,
        authWarning: "warn",
      },
      gatewayService: { label: "LaunchAgent", installed: true, loadedText: "loaded" },
      nodeService: { label: "node", installed: true, loadedText: "loaded" },
      agents: [{ id: "main" }],
      secretDiagnostics: ["diag"],
      securityAudit: { summary: { critical: 1 } },
      health: { ok: true },
      usage: { providers: [] },
      lastHeartbeat: { status: "ok" },
      pluginCompatibility: {
        count: 1,
        warnings: [
          {
            pluginId: "legacy",
            code: "legacy-before-agent-start",
            severity: "warn",
            message: "warn",
          },
        ],
      },
    });
  });

  it("omits optional sections when they are absent", () => {
    expect(
      buildStatusJsonPayload({
        summary: { ok: true },
        surface: {
          cfg: { gateway: {} },
          update: {
            root: "/tmp/openclaw",
            installKind: "package",
            packageManager: "npm",
          } as never,
          tailscaleMode: "off",
          gatewayMode: "local",
          remoteUrlMissing: false,
          gatewayConnection: { url: "ws://127.0.0.1:18789" },
          gatewayReachable: false,
          gatewayProbe: null,
          gatewayProbeAuth: null,
          gatewaySelf: null,
          gatewayProbeAuthWarning: null,
          gatewayService: { label: "LaunchAgent", installed: false, loadedText: "not installed" },
          nodeService: { label: "node", installed: false, loadedText: "not installed" },
        },
        osSummary: { platform: "linux" },
        memory: null,
        memoryPlugin: null,
        agents: [],
        secretDiagnostics: [],
      }),
    ).not.toHaveProperty("securityAudit");
  });

  it("includes model-pricing health from the gateway probe", () => {
    const payload = buildStatusJsonPayload({
      summary: { ok: true },
      surface: {
        cfg: { gateway: {} },
        update: {
          root: "/tmp/openclaw",
          installKind: "package",
          packageManager: "npm",
        } as never,
        tailscaleMode: "off",
        gatewayMode: "local",
        remoteUrlMissing: false,
        gatewayConnection: { url: "ws://127.0.0.1:18789" },
        gatewayReachable: true,
        gatewayProbe: {
          connectLatencyMs: 42,
          error: null,
          health: {
            ok: true,
            modelPricing: {
              state: "degraded",
              detail: "OpenRouter pricing fetch failed: TypeError: fetch failed",
              sources: [{ source: "openrouter", state: "degraded" }],
            },
          },
        },
        gatewayProbeAuth: null,
        gatewaySelf: null,
        gatewayProbeAuthWarning: null,
        gatewayService: { label: "LaunchAgent", installed: false, loadedText: "not installed" },
        nodeService: { label: "node", installed: false, loadedText: "not installed" },
      },
      osSummary: { platform: "linux" },
      memory: null,
      memoryPlugin: null,
      agents: [],
      secretDiagnostics: [],
    });

    const modelPricing = payload.gateway.modelPricing as
      | { state?: string; detail?: string }
      | undefined;
    expect(modelPricing?.state).toBe("degraded");
    expect(modelPricing?.detail).toBe("OpenRouter pricing fetch failed: TypeError: fetch failed");
  });
});

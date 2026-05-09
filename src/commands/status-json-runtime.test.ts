import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";

const mocks = vi.hoisted(() => ({
  buildStatusJsonPayload: vi.fn((input) => ({ built: true, input })),
  resolveStatusRuntimeSnapshot: vi.fn(),
}));

vi.mock("./status-json-payload.ts", () => ({
  buildStatusJsonPayload: mocks.buildStatusJsonPayload,
}));

vi.mock("./status-runtime-shared.ts", () => ({
  resolveStatusRuntimeSnapshot: mocks.resolveStatusRuntimeSnapshot,
}));

function createScan() {
  return {
    cfg: { update: { channel: "stable" }, gateway: {} },
    sourceConfig: { gateway: {} },
    summary: { ok: true },
    update: {
      root: "/tmp/openclaw",
      installKind: "package",
      packageManager: "npm",
    },
    osSummary: { platform: "linux" },
    memory: null,
    memoryPlugin: { enabled: true },
    gatewayMode: "local" as const,
    gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "config" },
    remoteUrlMissing: false,
    gatewayReachable: true,
    gatewayProbe: { connectLatencyMs: 42, error: null },
    gatewayProbeAuth: { token: "tok" },
    gatewaySelf: { host: "gateway" },
    gatewayProbeAuthWarning: null,
    agentStatus: { agents: [{ id: "main" }], defaultId: "main" },
    secretDiagnostics: [],
    pluginCompatibility: [
      {
        pluginId: "legacy",
        code: "legacy-before-agent-start",
        severity: "warn",
        message: "warn",
      },
    ],
  } satisfies Parameters<typeof resolveStatusJsonOutput>[0]["scan"];
}

describe("status-json-runtime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValue({
      securityAudit: { summary: { critical: 1 } },
      usage: { providers: [] },
      health: { ok: true },
      lastHeartbeat: { status: "ok" },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });
  });

  it("builds the full json output for status --json", async () => {
    const result = await resolveStatusJsonOutput({
      scan: createScan(),
      opts: { deep: true, usage: true, timeoutMs: 1234 },
      includeSecurityAudit: true,
      includePluginCompatibility: true,
    });

    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith({
      config: { update: { channel: "stable" }, gateway: {} },
      sourceConfig: { gateway: {} },
      timeoutMs: 1234,
      usage: true,
      deep: true,
      gatewayReachable: true,
      includeSecurityAudit: true,
      suppressHealthErrors: undefined,
    });
    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: expect.objectContaining({
          gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "config" },
          gatewayProbeAuth: { token: "tok" },
          gatewayService: { label: "LaunchAgent" },
          nodeService: { label: "node" },
        }),
        securityAudit: { summary: { critical: 1 } },
        usage: { providers: [] },
        health: { ok: true },
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
    );
    expect(result).toEqual({
      built: true,
      input: mocks.buildStatusJsonPayload.mock.calls[0][0],
    });
  });

  it("skips optional sections when flags are off", async () => {
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValueOnce({
      securityAudit: undefined,
      usage: undefined,
      health: undefined,
      lastHeartbeat: null,
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });

    await resolveStatusJsonOutput({
      scan: createScan(),
      opts: { deep: false, usage: false, timeoutMs: 500 },
      includeSecurityAudit: false,
      includePluginCompatibility: false,
    });

    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith({
      config: { update: { channel: "stable" }, gateway: {} },
      sourceConfig: { gateway: {} },
      timeoutMs: 500,
      usage: false,
      deep: false,
      gatewayReachable: true,
      includeSecurityAudit: false,
      suppressHealthErrors: undefined,
    });
    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: expect.objectContaining({
          gatewayProbeAuth: { token: "tok" },
        }),
        securityAudit: undefined,
        usage: undefined,
        health: undefined,
        lastHeartbeat: null,
        pluginCompatibility: undefined,
      }),
    );
  });

  it("suppresses health errors when requested", async () => {
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValueOnce({
      securityAudit: undefined,
      usage: undefined,
      health: undefined,
      lastHeartbeat: { status: "ok" },
      gatewayService: { label: "LaunchAgent" },
      nodeService: { label: "node" },
    });

    await resolveStatusJsonOutput({
      scan: createScan(),
      opts: { deep: true, timeoutMs: 500 },
      includeSecurityAudit: false,
      suppressHealthErrors: true,
    });

    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledWith(
      expect.objectContaining({
        surface: expect.objectContaining({
          gatewayProbeAuth: { token: "tok" },
        }),
        health: undefined,
      }),
    );
    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith({
      config: { update: { channel: "stable" }, gateway: {} },
      sourceConfig: { gateway: {} },
      timeoutMs: 500,
      usage: undefined,
      deep: true,
      gatewayReachable: true,
      includeSecurityAudit: false,
      suppressHealthErrors: true,
    });
  });
});

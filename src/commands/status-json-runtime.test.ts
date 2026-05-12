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

function requireStatusPayloadInput() {
  const call = mocks.buildStatusJsonPayload.mock.calls.at(0);
  if (!call) {
    throw new Error("expected status json payload call");
  }
  const [payloadInput] = call;
  return payloadInput;
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
    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledOnce();
    const payloadInput = requireStatusPayloadInput();
    expect(payloadInput.surface.gatewayConnection).toStrictEqual({
      url: "ws://127.0.0.1:18789",
      urlSource: "config",
    });
    expect(payloadInput.surface.gatewayProbeAuth).toStrictEqual({ token: "tok" });
    expect(payloadInput.surface.gatewayService).toStrictEqual({ label: "LaunchAgent" });
    expect(payloadInput.surface.nodeService).toStrictEqual({ label: "node" });
    expect(payloadInput.securityAudit).toStrictEqual({ summary: { critical: 1 } });
    expect(payloadInput.usage).toStrictEqual({ providers: [] });
    expect(payloadInput.health).toStrictEqual({ ok: true });
    expect(payloadInput.lastHeartbeat).toStrictEqual({ status: "ok" });
    expect(payloadInput.pluginCompatibility).toStrictEqual([
      {
        pluginId: "legacy",
        code: "legacy-before-agent-start",
        severity: "warn",
        message: "warn",
      },
    ]);
    expect(result).toEqual({
      built: true,
      input: payloadInput,
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
    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledOnce();
    const payloadInput = requireStatusPayloadInput();
    expect(payloadInput.surface.gatewayProbeAuth).toStrictEqual({ token: "tok" });
    expect(payloadInput.securityAudit).toBeUndefined();
    expect(payloadInput.usage).toBeUndefined();
    expect(payloadInput.health).toBeUndefined();
    expect(payloadInput.lastHeartbeat).toBeNull();
    expect(payloadInput.pluginCompatibility).toBeUndefined();
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

    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledOnce();
    const payloadInput = requireStatusPayloadInput();
    expect(payloadInput.surface.gatewayProbeAuth).toStrictEqual({ token: "tok" });
    expect(payloadInput.health).toBeUndefined();
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

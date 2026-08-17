// Status JSON runtime tests cover runtime status payload construction and command dependencies.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveStatusJsonOutput } from "./status-json-runtime.ts";

const mocks = vi.hoisted(() => ({
  buildStatusJsonPayload: vi.fn((input) => ({ built: true, input })),
  readBackupFreshness: vi.fn(() => ({
    latest: {
      id: "backup-1",
      createdAt: 123,
      archivePath: "/backups/git",
      status: "ok" as const,
      kind: "git" as const,
    },
  })),
  resolveStatusRuntimeSnapshot: vi.fn(),
}));

vi.mock("./backup-health.js", () => ({
  readBackupFreshness: mocks.readBackupFreshness,
}));

vi.mock("./status-json-payload.ts", () => ({
  buildStatusJsonPayload: mocks.buildStatusJsonPayload,
}));

vi.mock("./status-runtime-shared.ts", () => ({
  resolveStatusRuntimeSnapshot: mocks.resolveStatusRuntimeSnapshot,
}));

function createScan() {
  return {
    env: { OPENCLAW_STATE_DIR: "/tmp/status-json-runtime-state" },
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
        code: "hook-only",
        severity: "info",
        message: "warn",
      },
    ],
  } satisfies Parameters<typeof resolveStatusJsonOutput>[0]["scan"];
}

function requireStatusPayloadInput() {
  const call = mocks.buildStatusJsonPayload.mock.calls[0];
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
    const scan = createScan();
    const result = await resolveStatusJsonOutput({
      scan,
      opts: { deep: true, usage: true, agent: "beta", timeoutMs: 1234 },
      includeSecurityAudit: true,
      includePluginCompatibility: true,
    });

    expect(mocks.resolveStatusRuntimeSnapshot).toHaveBeenCalledWith({
      config: { update: { channel: "stable" }, gateway: {} },
      sourceConfig: { gateway: {} },
      timeoutMs: 1234,
      agentId: "beta",
      usage: true,
      deep: true,
      gatewayReachable: true,
      includeSecurityAudit: true,
      suppressHealthErrors: undefined,
    });
    expect(mocks.buildStatusJsonPayload).toHaveBeenCalledOnce();
    expect(mocks.readBackupFreshness).toHaveBeenCalledWith(scan.env);
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
        code: "hook-only",
        severity: "info",
        message: "warn",
      },
    ]);
    expect(result).toEqual({
      built: true,
      input: payloadInput,
      backups: mocks.readBackupFreshness(),
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

    const { env: _env, ...scanWithoutEnv } = createScan();
    await resolveStatusJsonOutput({
      scan: scanWithoutEnv,
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
    expect(mocks.readBackupFreshness).toHaveBeenCalledWith({});
    const payloadInput = requireStatusPayloadInput();
    expect(payloadInput.surface.gatewayProbeAuth).toStrictEqual({ token: "tok" });
    expect(payloadInput.securityAudit).toBeUndefined();
    expect(payloadInput.usage).toBeUndefined();
    expect(payloadInput.health).toBeUndefined();
    expect(payloadInput.lastHeartbeat).toBeNull();
    expect(payloadInput.pluginCompatibility).toBeUndefined();
  });

  it("preserves failed deep health probes in nonthrowing JSON output", async () => {
    mocks.resolveStatusRuntimeSnapshot.mockResolvedValueOnce({
      securityAudit: undefined,
      usage: undefined,
      health: { error: "gateway health probe timed out" },
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
    expect(payloadInput.health).toEqual({ error: "gateway health probe timed out" });
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

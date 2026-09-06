// Status JSON tests cover command output and runtime JSON writes.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeEnv } from "../runtime.js";
import { statusJsonCommand } from "./status-json.js";

const mocks = vi.hoisted(() => ({
  scanStatusJsonFast: vi.fn(),
  runSecurityAudit: vi.fn(),
  loadProviderUsageSummary: vi.fn(),
  callGateway: vi.fn(),
  getDaemonStatusSummary: vi.fn(),
  getNodeDaemonStatusSummary: vi.fn(),
  normalizeUpdateChannel: vi.fn((value?: string | null) => value ?? null),
  resolveUpdateChannelDisplay: vi.fn(() => ({
    channel: "stable",
    source: "config",
  })),
}));

vi.mock("./status.scan.fast-json.js", () => ({
  scanStatusJsonFast: mocks.scanStatusJsonFast,
}));

vi.mock("../security/audit.runtime.js", () => ({
  runSecurityAudit: mocks.runSecurityAudit,
}));

vi.mock("../infra/provider-usage.js", () => ({
  loadProviderUsageSummary: mocks.loadProviderUsageSummary,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
}));

vi.mock("./status.daemon.js", () => ({
  getDaemonStatusSummary: mocks.getDaemonStatusSummary,
  getNodeDaemonStatusSummary: mocks.getNodeDaemonStatusSummary,
}));

vi.mock("../infra/update-channels.js", () => ({
  normalizeUpdateChannel: mocks.normalizeUpdateChannel,
  resolveUpdateChannelDisplay: mocks.resolveUpdateChannelDisplay,
}));

function createRuntimeCapture() {
  const logs: string[] = [];
  const runtime: RuntimeEnv = {
    log: vi.fn((value: unknown) => {
      logs.push(String(value));
    }),
    error: vi.fn(),
    exit: vi.fn() as unknown as RuntimeEnv["exit"],
  };
  return { runtime, logs };
}

function createScanResult() {
  return {
    cfg: { update: { channel: "stable" } },
    sourceConfig: {},
    summary: { ok: true, configuredChannels: [] },
    osSummary: { platform: "linux" },
    update: { installKind: "npm", git: { tag: null, branch: null } },
    memory: null,
    memoryPlugin: null,
    gatewayMode: "local",
    gatewayConnection: { url: "ws://127.0.0.1:18789", urlSource: "config" },
    remoteUrlMissing: false,
    gatewayReachable: false,
    gatewayProbe: null,
    gatewaySelf: null,
    gatewayProbeAuthWarning: null,
    agentStatus: [],
    secretDiagnostics: [],
  };
}

function createExpectedStatusPayload() {
  return {
    ok: true,
    configuredChannels: [],
    os: { platform: "linux" },
    update: { installKind: "npm", git: { tag: null, branch: null } },
    updateChannel: "stable",
    updateChannelSource: "config",
    memory: null,
    memoryPlugin: null,
    gateway: {
      mode: "local",
      url: "ws://127.0.0.1:18789",
      urlSource: "config",
      misconfigured: false,
      reachable: false,
      connectLatencyMs: null,
      self: null,
      error: null,
      authWarning: null,
    },
    gatewayService: { installed: false },
    nodeService: { installed: false },
    agents: [],
    secretDiagnostics: [],
  };
}

describe("statusJsonCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.scanStatusJsonFast.mockResolvedValue(createScanResult());
    mocks.runSecurityAudit.mockResolvedValue({
      summary: { critical: 1, warn: 0, info: 0 },
      findings: [],
    });
    mocks.getDaemonStatusSummary.mockResolvedValue({ installed: false });
    mocks.getNodeDaemonStatusSummary.mockResolvedValue({ installed: false });
    mocks.loadProviderUsageSummary.mockResolvedValue({ providers: [] });
    mocks.callGateway.mockResolvedValue({});
  });

  it("keeps plain status --json off the security audit fast path", async () => {
    const { runtime, logs } = createRuntimeCapture();

    await statusJsonCommand({}, runtime);

    expect(mocks.runSecurityAudit).not.toHaveBeenCalled();
    expect(logs).toStrictEqual([expect.any(String)]);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual(createExpectedStatusPayload());
    expect(payload).not.toHaveProperty("securityAudit");
  });

  it("includes security audit and plugin compatibility details when --all is requested", async () => {
    const { runtime, logs } = createRuntimeCapture();
    const compatibilityNotice = {
      pluginId: "legacy-plugin",
      code: "hook-only",
      severity: "warn",
      message: "plugin registers only legacy hooks",
    };
    mocks.scanStatusJsonFast.mockResolvedValueOnce({
      ...createScanResult(),
      pluginCompatibility: [compatibilityNotice],
    });

    await statusJsonCommand({ all: true }, runtime);

    expect(mocks.runSecurityAudit).toHaveBeenCalledExactlyOnceWith({
      config: { update: { channel: "stable" } },
      sourceConfig: {},
      deep: false,
      includeFilesystem: true,
      includeChannelSecurity: true,
      loadPluginSecurityCollectors: false,
    });
    expect(logs).toStrictEqual([expect.any(String)]);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload).toEqual({
      ...createExpectedStatusPayload(),
      securityAudit: {
        summary: { critical: 1, warn: 0, info: 0 },
        findings: [],
      },
      pluginCompatibility: {
        count: 1,
        warnings: [compatibilityNotice],
      },
    });
  });

  it("reports deep gateway probe failures and runs the documented security audit", async () => {
    const { runtime, logs } = createRuntimeCapture();
    mocks.scanStatusJsonFast.mockResolvedValueOnce({
      ...createScanResult(),
      gatewayReachable: true,
    });
    mocks.callGateway.mockImplementation(async (params: { method?: string }) => {
      if (params.method === "health") {
        throw new Error("gateway health probe timed out");
      }
      return null;
    });

    await statusJsonCommand({ deep: true }, runtime);

    expect(mocks.runSecurityAudit).toHaveBeenCalledOnce();
    const payload = JSON.parse(logs[0] ?? "{}") as {
      health?: { error?: string };
      securityAudit?: { summary?: { critical?: number } };
    };
    expect(payload.health).toEqual({ error: "Error: gateway health probe timed out" });
    expect(payload.securityAudit?.summary?.critical).toBe(1);
  });
});

// Dashboard command tests cover dashboard URL selection, gateway bind modes, and runtime output.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBindMode } from "../config/types.gateway.js";
import { dashboardCommand } from "./dashboard.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  copyToClipboard: vi.fn(),
  openUrl: vi.fn(),
  inspectPortUsage: vi.fn(),
  ensureGatewayReadyForOperation: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  detectBrowserOpenSupport: vi.fn(),
  openUrl: mocks.openUrl,
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("../infra/ports-inspect.js", () => ({
  inspectPortUsage: mocks.inspectPortUsage,
}));

vi.mock("./gateway-readiness.js", () => ({
  ensureGatewayReadyForOperation: mocks.ensureGatewayReadyForOperation,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

type SnapshotParams = {
  token?: string;
  bind?: GatewayBindMode;
  customBindHost?: string;
  tlsEnabled?: boolean;
};

function createSnapshot(params?: SnapshotParams) {
  const token = params?.token ?? "abc123";
  const gateway = {
    auth: { token },
    bind: params?.bind,
    customBindHost: params?.customBindHost,
    ...(params?.tlsEnabled === undefined ? {} : { tls: { enabled: params.tlsEnabled } }),
  };
  return {
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config: {
      gateway,
    },
    issues: [],
    legacyIssues: [],
  };
}

function mockSnapshot(params?: SnapshotParams) {
  mocks.readConfigFileSnapshot.mockResolvedValue(createSnapshot(params));
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.resolveControlUiLinks.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  mocks.copyToClipboard.mockResolvedValue(true);
}

function mockSpecificDashboardLinks(params: {
  bind: "custom" | "tailnet";
  host: string;
  tlsEnabled?: boolean;
}) {
  const scheme = params.tlsEnabled ? { http: "https", ws: "wss" } : { http: "http", ws: "ws" };
  mocks.resolveControlUiLinks.mockImplementation(({ bind }: { bind: GatewayBindMode }) =>
    bind === params.bind
      ? {
          httpUrl: `${scheme.http}://${params.host}:18789/`,
          wsUrl: `${scheme.ws}://${params.host}:18789`,
        }
      : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
  );
}

function mockAliasOwnership(host: string, loopbackPid = 4242) {
  mocks.inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "busy",
    listeners: [
      { pid: 4242, commandLine: "openclaw-gateway", address: `${host}:18789` },
      { pid: loopbackPid, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
    ],
    hints: [],
  });
}

describe("dashboardCommand bind selection", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockClear();
    mocks.resolveGatewayPort.mockClear();
    mocks.resolveControlUiLinks.mockClear();
    mocks.copyToClipboard.mockClear();
    mocks.openUrl.mockClear();
    mocks.inspectPortUsage.mockReset();
    mocks.ensureGatewayReadyForOperation.mockReset();
    mocks.ensureGatewayReadyForOperation.mockResolvedValue({
      ready: true,
      status: {},
      recovered: false,
    });
    runtime.log.mockClear();
    runtime.error.mockClear();
    runtime.exit.mockClear();
  });

  it.each([
    { label: "maps lan bind to loopback", snapshot: { bind: "lan" as const } },
    { label: "defaults unset bind to loopback", snapshot: undefined },
  ])("$label for dashboard URLs", async ({ snapshot }) => {
    mockSnapshot(snapshot);

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: "loopback",
      customBindHost: undefined,
      basePath: undefined,
      tlsEnabled: false,
    });
  });

  it("maps a TLS-enabled wildcard custom bind to loopback", async () => {
    mockSnapshot({ bind: "custom", customBindHost: "0.0.0.0", tlsEnabled: true });

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: "loopback",
      customBindHost: "0.0.0.0",
      basePath: undefined,
      tlsEnabled: true,
    });
  });

  it.each([
    { bind: "custom" as const, host: "10.0.0.5", customBindHost: "10.0.0.5" },
    { bind: "tailnet" as const, host: "100.64.0.1", customBindHost: undefined },
  ])("maps plain-http $bind bind to a verified loopback URL", async (params) => {
    mockSnapshot({ bind: params.bind, customBindHost: params.customBindHost });
    mockSpecificDashboardLinks(params);
    mockAliasOwnership(params.host);

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.ensureGatewayReadyForOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        probeUrl: `ws://${params.host}:18789`,
        readyWhenReachable: true,
      }),
    );
    expect(mocks.ensureGatewayReadyForOperation.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.inspectPortUsage.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );
    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: "loopback",
      customBindHost: params.customBindHost,
      basePath: undefined,
      tlsEnabled: false,
    });
    expect(mocks.copyToClipboard).toHaveBeenCalledWith("http://127.0.0.1:18789/#token=abc123");
  });

  it("refuses an authenticated loopback URL owned by a different process", async () => {
    mockSnapshot({ bind: "custom", customBindHost: "10.0.0.5" });
    mockSpecificDashboardLinks({ bind: "custom", host: "10.0.0.5" });
    mockAliasOwnership("10.0.0.5", 4343);

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining("refusing to copy or open an authenticated URL"),
    );
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Dashboard URL:"));
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("refuses URL delivery when loopback ownership inspection fails", async () => {
    mockSnapshot({ bind: "custom", customBindHost: "10.0.0.5" });
    mockSpecificDashboardLinks({ bind: "custom", host: "10.0.0.5" });
    mocks.inspectPortUsage.mockRejectedValue(new Error("inspection unavailable"));

    await dashboardCommand(runtime);

    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Dashboard URL:"));
  });

  it("re-probes a changed endpoint after recovery before URL delivery", async () => {
    mockSnapshot({ bind: "custom", customBindHost: "10.0.0.5" });
    mocks.readConfigFileSnapshot
      .mockResolvedValueOnce(createSnapshot({ bind: "custom", customBindHost: "10.0.0.5" }))
      .mockResolvedValueOnce(createSnapshot({ bind: "custom", customBindHost: "10.0.0.6" }));
    mocks.resolveControlUiLinks.mockImplementation(
      ({ bind, customBindHost }: { bind: GatewayBindMode; customBindHost?: string }) =>
        bind === "custom"
          ? {
              httpUrl: `http://${customBindHost}:18789/`,
              wsUrl: `ws://${customBindHost}:18789`,
            }
          : { httpUrl: "http://127.0.0.1:18789/", wsUrl: "ws://127.0.0.1:18789" },
    );
    mocks.ensureGatewayReadyForOperation
      .mockResolvedValueOnce({ ready: true, status: {}, recovered: true })
      .mockResolvedValueOnce({
        ready: false,
        status: {},
        reason: "Gateway probe failed",
        recoverable: false,
      });

    await dashboardCommand(runtime, { noOpen: true, yes: true });

    expect(mocks.ensureGatewayReadyForOperation).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ probeUrl: "ws://10.0.0.5:18789" }),
    );
    expect(mocks.ensureGatewayReadyForOperation).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        probeUrl: "ws://10.0.0.6:18789",
        readyWhenReachable: true,
        allowInstall: false,
        interactive: false,
      }),
    );
    expect(mocks.inspectPortUsage).not.toHaveBeenCalled();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(runtime.log).not.toHaveBeenCalledWith(expect.stringContaining("Dashboard URL:"));
  });

  it.each([
    { bind: "custom" as const, host: "10.0.0.5", customBindHost: "10.0.0.5" },
    { bind: "tailnet" as const, host: "100.64.0.1", customBindHost: undefined },
  ])("preserves a specific $bind bind when TLS provides a secure context", async (params) => {
    mockSnapshot({
      bind: params.bind,
      customBindHost: params.customBindHost,
      tlsEnabled: true,
    });
    mockSpecificDashboardLinks({ ...params, tlsEnabled: true });

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.ensureGatewayReadyForOperation).toHaveBeenCalledWith(
      expect.objectContaining({ probeUrl: `wss://${params.host}:18789` }),
    );
    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: params.bind,
      customBindHost: params.customBindHost,
      basePath: undefined,
      tlsEnabled: true,
    });
    expect(mocks.inspectPortUsage).not.toHaveBeenCalled();
  });
});

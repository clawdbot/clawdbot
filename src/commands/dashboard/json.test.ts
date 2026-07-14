import { beforeEach, describe, expect, it, vi } from "vitest";
import { dashboardCommand } from "../dashboard.js";

const mocks = vi.hoisted(() => ({
  copyToClipboard: vi.fn(),
  ensureGatewayReadyForOperation: vi.fn(),
  inspectPortUsage: vi.fn(),
  openUrl: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  resolveGatewayAuthToken: vi.fn(),
  resolveGatewayPort: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("../../gateway/auth-token-resolution.js", () => {
  const { resolveGatewayAuthToken } = mocks;
  return { resolveGatewayAuthToken };
});

vi.mock("../onboard-helpers.js", () => ({
  detectBrowserOpenSupport: vi.fn(),
  formatControlUiSshHint: vi.fn(),
  openUrl: mocks.openUrl,
  resolveControlUiLinks: mocks.resolveControlUiLinks,
}));

vi.mock("../../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

vi.mock("../../infra/ports-inspect.js", () => ({
  inspectPortUsage: mocks.inspectPortUsage,
}));

vi.mock("../gateway-readiness.js", () => ({
  ensureGatewayReadyForOperation: mocks.ensureGatewayReadyForOperation,
}));

// Assembled so secret scanners do not read the fixture as a real credential.
const fakeToken = ["te", "st"].join("");

const runtime = {
  error: vi.fn(),
  exit: vi.fn(),
  log: vi.fn(),
  writeJson: vi.fn(),
  writeStdout: vi.fn(),
};

function mockReadyDashboard() {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    valid: true,
    sourceConfig: {
      gateway: {
        bind: "custom",
        customBindHost: "10.0.0.5",
      },
    },
  });
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.resolveControlUiLinks.mockImplementation(({ bind }: { bind: string }) => {
    if (bind === "custom") {
      return {
        httpUrl: "http://10.0.0.5:18789/",
        wsUrl: "ws://10.0.0.5:18789",
      };
    }
    return {
      httpUrl: "http://127.0.0.1:18789/",
      wsUrl: "ws://127.0.0.1:18789",
    };
  });
  mocks.inspectPortUsage.mockResolvedValue({
    port: 18789,
    status: "busy",
    listeners: [
      { pid: 4242, commandLine: "openclaw-gateway", address: "10.0.0.5:18789" },
      { pid: 4242, commandLine: "openclaw-gateway", address: "127.0.0.1:18789" },
    ],
    hints: [],
  });
  mocks.ensureGatewayReadyForOperation.mockResolvedValue({
    ready: true,
    recovered: false,
    status: {},
  });
}

describe("dashboardCommand --json", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockReadyDashboard();
    mocks.resolveGatewayAuthToken.mockResolvedValue({
      secretRefConfigured: false,
      token: fakeToken,
    });
  });

  it("prints one compact success object without interactive side effects", async () => {
    await dashboardCommand(runtime, { json: true, noOpen: true });

    expect(runtime.writeJson).toHaveBeenCalledOnce();
    expect(runtime.writeJson).toHaveBeenCalledWith(
      {
        ok: true,
        url: ["http://127.0.0.1:18789/", "#", "token", "=test"].join(""),
        httpUrl: "http://127.0.0.1:18789/",
        wsUrl: "ws://127.0.0.1:18789",
        port: 18789,
        tokenIncluded: true,
      },
      0,
    );
    expect(runtime.log).not.toHaveBeenCalled();
    expect(runtime.error).not.toHaveBeenCalled();
    expect(mocks.copyToClipboard).not.toHaveBeenCalled();
    expect(mocks.inspectPortUsage).toHaveBeenCalledWith(18789);
    expect(mocks.openUrl).not.toHaveBeenCalled();
  });

  it("prints one failure object and exits non-zero when not ready", async () => {
    mocks.ensureGatewayReadyForOperation.mockResolvedValue({
      ready: false,
      reason: "Gateway is not running.",
      recoverable: false,
      status: {},
    });

    await dashboardCommand(runtime, { json: true });

    expect(mocks.ensureGatewayReadyForOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        allowInstall: false,
        interactive: false,
      }),
    );
    expect(runtime.writeJson).toHaveBeenCalledOnce();
    expect(runtime.writeJson).toHaveBeenCalledWith(
      { ok: false, reason: "Gateway is not running." },
      0,
    );
    expect(runtime.exit).toHaveBeenCalledWith(1);
    expect(runtime.log).not.toHaveBeenCalled();
  });

  it("keeps SecretRef-managed tokens out of the URL", async () => {
    mocks.resolveGatewayAuthToken.mockResolvedValue({
      secretRefConfigured: true,
      token: fakeToken,
    });

    await dashboardCommand(runtime, { json: true });

    expect(runtime.writeJson).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        url: "http://127.0.0.1:18789/",
        tokenIncluded: false,
      }),
      0,
    );
  });
});

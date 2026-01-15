import { beforeEach, describe, expect, it, vi } from "vitest";

import { dashboardCommand } from "./dashboard.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  detectBrowserOpenSupport: vi.fn(),
  openUrl: vi.fn(),
  formatControlUiSshHint: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  detectBrowserOpenSupport: mocks.detectBrowserOpenSupport,
  openUrl: mocks.openUrl,
  formatControlUiSshHint: mocks.formatControlUiSshHint,
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function resetRuntime() {
  runtime.log.mockClear();
  runtime.error.mockClear();
  runtime.exit.mockClear();
}

function mockSnapshot(token = "abc") {
  mocks.readConfigFileSnapshot.mockResolvedValue({
    path: "/tmp/clawdbot.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config: { gateway: { auth: { token } } },
    issues: [],
    legacyIssues: [],
  });
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.resolveControlUiLinks.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
}

describe("dashboardCommand", () => {
  beforeEach(() => {
    resetRuntime();
    mocks.readConfigFileSnapshot.mockReset();
    mocks.resolveGatewayPort.mockReset();
    mocks.resolveControlUiLinks.mockReset();
    mocks.detectBrowserOpenSupport.mockReset();
    mocks.openUrl.mockReset();
    mocks.formatControlUiSshHint.mockReset();
    mocks.copyToClipboard.mockReset();
  });

  it("opens and copies the dashboard link by default", async () => {
    mockSnapshot("abc123");
    mocks.copyToClipboard.mockResolvedValue(true);
    mocks.detectBrowserOpenSupport.mockResolvedValue({ ok: true });
    mocks.openUrl.mockResolvedValue(true);

    await dashboardCommand(runtime);

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: "loopback",
      customBindHost: undefined,
      basePath: undefined,
    });
    expect(mocks.copyToClipboard).toHaveBeenCalledWith("http://127.0.0.1:18789/?token=abc123");
    expect(mocks.openUrl).toHaveBeenCalledWith("http://127.0.0.1:18789/?token=abc123");
    expect(runtime.log).toHaveBeenCalledWith(
      "Opened in your browser. Keep that tab to control Clawdbot.",
    );
  });

  it("prints SSH hint when browser cannot open", async () => {
    mockSnapshot("shhhh");
    mocks.copyToClipboard.mockResolvedValue(false);
    mocks.detectBrowserOpenSupport.mockResolvedValue({
      ok: false,
      reason: "ssh",
    });
    mocks.formatControlUiSshHint.mockReturnValue("ssh hint");

    await dashboardCommand(runtime);

    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith("ssh hint");
  });

  it("respects --no-open and skips browser attempts", async () => {
    mockSnapshot();
    mocks.copyToClipboard.mockResolvedValue(true);

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.detectBrowserOpenSupport).not.toHaveBeenCalled();
    expect(mocks.openUrl).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "Browser launch disabled (--no-open). Use the URL above.",
    );
  });
});

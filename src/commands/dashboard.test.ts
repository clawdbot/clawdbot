import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayBindMode } from "../config/types.gateway.js";
import { dashboardCommand } from "./dashboard.js";

const mocks = vi.hoisted(() => ({
  readConfigFileSnapshot: vi.fn(),
  resolveGatewayPort: vi.fn(),
  resolveControlUiLinks: vi.fn(),
  copyToClipboard: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  readConfigFileSnapshot: mocks.readConfigFileSnapshot,
  resolveGatewayPort: mocks.resolveGatewayPort,
}));

vi.mock("./onboard-helpers.js", () => ({
  resolveControlUiLinks: mocks.resolveControlUiLinks,
  detectBrowserOpenSupport: vi.fn(),
  openUrl: vi.fn(),
  formatControlUiSshHint: vi.fn(() => "ssh hint"),
}));

vi.mock("../infra/clipboard.js", () => ({
  copyToClipboard: mocks.copyToClipboard,
}));

const runtime = {
  log: vi.fn(),
  error: vi.fn(),
  exit: vi.fn(),
};

function mockSnapshot(params?: {
  token?: string;
  bind?: GatewayBindMode;
  customBindHost?: string;
}) {
  const token = params?.token ?? "abc123";
  mocks.readConfigFileSnapshot.mockResolvedValue({
    path: "/tmp/openclaw.json",
    exists: true,
    raw: "{}",
    parsed: {},
    valid: true,
    config: {
      gateway: {
        auth: { token },
        bind: params?.bind,
        customBindHost: params?.customBindHost,
      },
    },
    issues: [],
    legacyIssues: [],
  });
  mocks.resolveGatewayPort.mockReturnValue(18789);
  mocks.resolveControlUiLinks.mockReturnValue({
    httpUrl: "http://127.0.0.1:18789/",
    wsUrl: "ws://127.0.0.1:18789",
  });
  mocks.copyToClipboard.mockResolvedValue(true);
}

describe("dashboardCommand bind selection", () => {
  beforeEach(() => {
    mocks.readConfigFileSnapshot.mockClear();
    mocks.resolveGatewayPort.mockClear();
    mocks.resolveControlUiLinks.mockClear();
    mocks.copyToClipboard.mockClear();
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

  it("preserves custom bind mode", async () => {
    mockSnapshot({ bind: "custom", customBindHost: "10.0.0.5" });

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: "custom",
      customBindHost: "10.0.0.5",
      basePath: undefined,
      tlsEnabled: false,
    });
  });

  it("preserves tailnet bind mode", async () => {
    mockSnapshot({ bind: "tailnet" });

    await dashboardCommand(runtime, { noOpen: true });

    expect(mocks.resolveControlUiLinks).toHaveBeenCalledWith({
      port: 18789,
      bind: "tailnet",
      customBindHost: undefined,
      basePath: undefined,
      tlsEnabled: false,
    });
  });
});

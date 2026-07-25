// Qqbot tests cover channel gateway status truth on disconnect.
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { afterEach, describe, expect, it, vi } from "vitest";
import { qqbotPlugin } from "./channel.js";
import type { ResolvedQQBotAccount } from "./types.js";

const startGatewayMock = vi.hoisted(() => vi.fn());

vi.mock("./bridge/gateway.js", () => ({
  startGateway: startGatewayMock,
}));

type StartGatewayOptions = {
  onReady?: (data: unknown) => void;
  onResumed?: (data: unknown) => void;
  onError?: (error: Error) => void;
  onDisconnected?: (info: { reason?: string; fatal?: boolean }) => void;
};

async function startAccountAndCaptureGatewayOptions() {
  startGatewayMock.mockImplementation(() => new Promise<void>(() => {}));
  const statusWrites: ChannelAccountSnapshot[] = [];
  let status: ChannelAccountSnapshot = {
    accountId: "test-account",
    running: true,
    connected: false,
    lastConnectedAt: null,
    lastError: null,
  };
  const account = {
    accountId: "test-account",
    appId: "test-app",
    clientSecret: "test-secret",
    enabled: true,
    markdownSupport: false,
    config: {},
    secretSource: "config",
  } as unknown as ResolvedQQBotAccount;
  const ctx = {
    cfg: {},
    accountId: "test-account",
    account,
    runtime: {},
    abortSignal: new AbortController().signal,
    getStatus: () => status,
    setStatus: (next: ChannelAccountSnapshot) => {
      status = next;
      statusWrites.push(next);
    },
  };
  const startAccount = qqbotPlugin.gateway?.startAccount;
  expect(startAccount).toBeDefined();
  void startAccount?.(ctx as Parameters<NonNullable<typeof startAccount>>[0]);
  await vi.waitFor(() => {
    expect(startGatewayMock).toHaveBeenCalled();
  });
  const options = startGatewayMock.mock.calls[0]?.[0] as StartGatewayOptions;
  return { account, options, statusWrites, getStatus: () => status };
}

describe("qqbot channel gateway status", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("marks the account disconnected when the gateway reports a disconnect", async () => {
    const { options, getStatus } = await startAccountAndCaptureGatewayOptions();

    options.onReady?.({});
    expect(getStatus().connected).toBe(true);

    expect(options.onDisconnected).toBeDefined();
    options.onDisconnected?.({ reason: "close code 1006", fatal: false });
    expect(getStatus().connected).toBe(false);
    expect(getStatus().running).toBe(true);
  });

  it("marks fatal disconnects unhealthy and records the close reason", async () => {
    const { account, options, getStatus } = await startAccountAndCaptureGatewayOptions();

    options.onReady?.({});
    options.onDisconnected?.({ reason: "banned", fatal: true });

    expect(getStatus().connected).toBe(false);
    // `running` is owned by the gateway lifecycle store: the account task
    // stays held until an explicit stop/abort, so the plugin must not
    // flip it here (a Start action would no-op against a held task).
    expect(getStatus().running).toBe(true);
    expect(getStatus().lastError).toBe("banned");

    const publicStatus = await qqbotPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg: {},
      runtime: getStatus(),
    });
    expect(publicStatus?.connected).toBe(false);
    expect(publicStatus?.lastError).toBe("banned");
  });

  it("clears fatal errors when the gateway becomes ready or resumes", async () => {
    const { options, getStatus } = await startAccountAndCaptureGatewayOptions();

    options.onReady?.({});
    options.onDisconnected?.({ reason: "banned", fatal: true });
    options.onResumed?.({});

    expect(getStatus().connected).toBe(true);
    expect(getStatus().lastError).toBeNull();

    options.onDisconnected?.({ reason: "offline/sandbox-only", fatal: true });
    options.onReady?.({});

    expect(getStatus().connected).toBe(true);
    expect(getStatus().lastError).toBeNull();
  });
});

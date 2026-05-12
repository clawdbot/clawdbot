import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GatewayRequestHandlerOptions } from "./types.js";

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  applyPluginAutoEnable: vi.fn(),
  listChannelPlugins: vi.fn(),
  buildChannelUiCatalog: vi.fn(),
  buildChannelAccountSnapshot: vi.fn(),
  getChannelActivity: vi.fn(),
}));

vi.mock("../../config/config.js", () => ({
  getRuntimeConfig: mocks.getRuntimeConfig,
  readConfigFileSnapshot: vi.fn(async () => ({
    config: {},
    path: "openclaw.config.json",
    raw: "{}",
  })),
}));

vi.mock("../../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: mocks.applyPluginAutoEnable,
}));

vi.mock("../../channels/plugins/index.js", () => ({
  listChannelPlugins: mocks.listChannelPlugins,
  getLoadedChannelPlugin: vi.fn(),
  getChannelPlugin: vi.fn(),
  normalizeChannelId: (value: string) => value,
}));

vi.mock("../../channels/plugins/catalog.js", () => ({
  buildChannelUiCatalog: mocks.buildChannelUiCatalog,
}));

vi.mock("../../channels/plugins/status.js", () => ({
  buildChannelAccountSnapshot: mocks.buildChannelAccountSnapshot,
}));

vi.mock("../../infra/channel-activity.js", () => ({
  getChannelActivity: mocks.getChannelActivity,
}));

import { channelsHandlers } from "./channels.js";

function getSuccessPayload(respond: ReturnType<typeof vi.fn>): Record<string, unknown> {
  return requireRespondPayload(respond);
}

function createOptions(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
): GatewayRequestHandlerOptions {
  return {
    req: { type: "req", id: "req-1", method: "channels.status", params },
    params,
    client: null,
    isWebchatConnect: () => false,
    respond: vi.fn(),
    context: {
      getRuntimeConfig: mocks.getRuntimeConfig,
      getRuntimeSnapshot: () => ({
        channels: {},
        channelAccounts: {},
      }),
    },
    ...overrides,
  } as unknown as GatewayRequestHandlerOptions;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected record");
  }
  return value as Record<string, unknown>;
}

function requireFirstCallArg(mock: { mock: { calls: readonly (readonly unknown[])[] } }) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("Expected first mock call");
  }
  return call[0];
}

function requireRespondPayload(respond: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const call = respond.mock.calls[0];
  if (!call) {
    throw new Error("Expected respond call");
  }
  expect(call[0]).toBe(true);
  expect(call[2]).toBeUndefined();
  return requireRecord(call[1]);
}

describe("channelsHandlers channels.status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getRuntimeConfig.mockReturnValue({});
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({ config, changes: [] }));
    mocks.buildChannelUiCatalog.mockReturnValue({
      order: ["whatsapp"],
      labels: { whatsapp: "WhatsApp" },
      detailLabels: { whatsapp: "WhatsApp" },
      systemImages: { whatsapp: undefined },
      entries: { whatsapp: { id: "whatsapp" } },
    });
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    mocks.getChannelActivity.mockReturnValue({
      inboundAt: null,
      outboundAt: null,
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: async (_account: unknown, cfg: { autoEnabled?: boolean }) =>
            Boolean(cfg.autoEnabled),
        },
      },
    ]);
  });

  it("uses the auto-enabled config snapshot for channel account state", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    const respond = vi.fn();
    const opts = createOptions(
      { probe: false, timeoutMs: 2000 },
      {
        respond,
      },
    );

    await channelsHandlers["channels.status"](opts);

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
      env: process.env,
    });
    const snapshotArgs = requireRecord(requireFirstCallArg(mocks.buildChannelAccountSnapshot));
    expect(snapshotArgs.cfg).toBe(autoEnabledConfig);
    expect(snapshotArgs.accountId).toBe("default");
    const payload = requireRespondPayload(respond);
    const channels = requireRecord(payload.channels);
    const whatsapp = requireRecord(channels.whatsapp);
    expect(whatsapp.configured).toBe(true);
  });

  it("caps probe timeout before passing it to channel plugins", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    const probeAccount = vi.fn(async () => ({ ok: true }));
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: async () => true,
        },
        status: {
          probeAccount,
        },
      },
    ]);

    await channelsHandlers["channels.status"](createOptions({ probe: true, timeoutMs: 999_999 }));

    const probeArgs = requireRecord(requireFirstCallArg(probeAccount));
    expect(probeArgs.timeoutMs).toBe(30_000);
    expect(probeArgs.cfg).toBe(autoEnabledConfig);
  });

  it("filters channel status to a requested channel", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    const whatsappProbe = vi.fn(async () => ({ ok: true }));
    const imessageProbe = vi.fn(async () => ({ ok: true }));
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.buildChannelUiCatalog.mockImplementation((plugins: Array<{ id: string }>) => ({
      order: plugins.map((plugin) => plugin.id),
      labels: Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.id])),
      detailLabels: Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.id])),
      systemImages: {},
      entries: Object.fromEntries(plugins.map((plugin) => [plugin.id, { id: plugin.id }])),
    }));
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: async () => true,
        },
        status: { probeAccount: whatsappProbe },
      },
      {
        id: "imessage",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: async () => true,
        },
        status: { probeAccount: imessageProbe },
      },
    ]);
    const respond = vi.fn();

    await channelsHandlers["channels.status"](
      createOptions({ channel: "imessage", probe: true, timeoutMs: 1000 }, { respond }),
    );

    expect(whatsappProbe).not.toHaveBeenCalled();
    expect(imessageProbe).toHaveBeenCalledOnce();
    const payload = requireRespondPayload(respond);
    expect(payload.channelOrder).toEqual(["imessage"]);
    expect(payload.channels).toEqual({
      imessage: expect.any(Object),
    });
    expect(payload.channelAccounts).toEqual({
      imessage: [expect.objectContaining({ accountId: "default" })],
    });
  });

  it("preserves channel account rows when a live probe throws", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    const probeAccount = vi.fn(async () => {
      throw new Error("probe failed");
    });
    const respond = vi.fn();
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.buildChannelAccountSnapshot.mockImplementation(async ({ accountId, probe }) => ({
      accountId,
      configured: true,
      probe,
    }));
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: async () => true,
        },
        status: {
          probeAccount,
        },
      },
    ]);

    await channelsHandlers["channels.status"](
      createOptions({ probe: true, timeoutMs: 1000 }, { respond }),
    );

    const payload = getSuccessPayload(respond);
    const channelAccounts = requireRecord(payload.channelAccounts);
    expect(Array.isArray(channelAccounts.whatsapp)).toBe(true);
    const [whatsappAccount] = channelAccounts.whatsapp as unknown[];
    const account = requireRecord(whatsappAccount);
    expect(account.accountId).toBe("default");
    expect(String(account.lastError)).toContain("probe failed");
    expect(typeof account.lastProbeAt).toBe("number");
    const accountProbe = requireRecord(account.probe);
    expect(accountProbe.ok).toBe(false);
    expect(String(accountProbe.error)).toContain("probe failed");
  });

  it("returns a partial snapshot when a channel probe exceeds the status budget", async () => {
    vi.useFakeTimers();
    try {
      const autoEnabledConfig = { autoEnabled: true };
      const probeAccount = vi.fn(() => new Promise(() => undefined));
      mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
      mocks.listChannelPlugins.mockReturnValue([
        {
          id: "whatsapp",
          config: {
            listAccountIds: () => ["default"],
            resolveAccount: () => ({}),
            isEnabled: () => true,
            isConfigured: async () => true,
          },
          status: {
            probeAccount,
          },
        },
      ]);
      const respond = vi.fn();
      const run = channelsHandlers["channels.status"](
        createOptions({ probe: true, timeoutMs: 1000 }, { respond }),
      );

      await vi.advanceTimersByTimeAsync(1000);
      await run;

      const snapshotArgs = requireRecord(requireFirstCallArg(mocks.buildChannelAccountSnapshot));
      const probe = requireRecord(snapshotArgs.probe);
      expect(probe.timedOut).toBe(true);
      const payload = requireRespondPayload(respond);
      expect(payload.partial).toBe(true);
      expect(payload.warnings).toEqual(["whatsapp:default probe timed out after 1000ms"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to account-derived channel summaries when summary building fails", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    const respond = vi.fn();
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    mocks.listChannelPlugins.mockReturnValue([
      {
        id: "whatsapp",
        config: {
          listAccountIds: () => ["default"],
          resolveAccount: () => ({}),
          isEnabled: () => true,
          isConfigured: async () => true,
        },
        status: {
          buildChannelSummary: async () => {
            throw new Error("summary failed");
          },
        },
      },
    ]);

    await channelsHandlers["channels.status"](
      createOptions({ probe: false, timeoutMs: 1000 }, { respond }),
    );

    const payload = getSuccessPayload(respond);
    const channels = requireRecord(payload.channels);
    const whatsapp = requireRecord(channels.whatsapp);
    expect(whatsapp.configured).toBe(true);
    expect(String(whatsapp.lastError)).toContain("summary failed");

    const channelAccounts = requireRecord(payload.channelAccounts);
    expect(Array.isArray(channelAccounts.whatsapp)).toBe(true);
    const [whatsappAccount] = channelAccounts.whatsapp as unknown[];
    const account = requireRecord(whatsappAccount);
    expect(account.accountId).toBe("default");
    expect(account.configured).toBe(true);
  });

  it("annotates unhealthy channel snapshots and includes event-loop health", async () => {
    const now = Date.now();
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.buildChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lastStartAt: now - 60 * 60_000,
      lastTransportActivityAt: now - 40 * 60_000,
    });
    const eventLoop = {
      degraded: true,
      reasons: ["event_loop_delay"],
      intervalMs: 62_000,
      delayP99Ms: 62_000,
      delayMaxMs: 62_000,
      utilization: 1,
      cpuCoreRatio: 1,
    };
    const respond = vi.fn();

    await channelsHandlers["channels.status"](
      createOptions(
        { probe: false, timeoutMs: 2000 },
        {
          respond,
          context: {
            getRuntimeConfig: mocks.getRuntimeConfig,
            getRuntimeSnapshot: () => ({
              channels: {},
              channelAccounts: {},
            }),
            getEventLoopHealth: () => eventLoop,
          } as never,
        },
      ),
    );

    const payload = requireRespondPayload(respond);
    expect(payload.eventLoop).toBe(eventLoop);
    const channelAccounts = requireRecord(payload.channelAccounts);
    expect(Array.isArray(channelAccounts.whatsapp)).toBe(true);
    const [whatsappAccount] = channelAccounts.whatsapp as unknown[];
    expect(requireRecord(whatsappAccount).healthState).toBe("stale-socket");
  });
});

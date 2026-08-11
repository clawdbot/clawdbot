/**
 * Gateway channels.status method tests.
 */

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { requireRecord } from "../test-helpers.assertions.js";
import type { GatewayRequestHandlerOptions } from "./types.js";

type ChannelTestPlugin = {
  id: string;
  config: {
    listAccountIds: () => string[];
    resolveAccount: () => Record<string, never>;
    isEnabled: () => boolean;
    isConfigured: (_account: unknown, cfg: { autoEnabled?: boolean }) => boolean | Promise<boolean>;
  };
  status?: {
    probeAccount?: (params?: unknown) => unknown;
    buildChannelSummary?: () => unknown;
  };
};

const mocks = vi.hoisted(() => ({
  getRuntimeConfig: vi.fn(() => ({})),
  applyPluginAutoEnable: vi.fn(),
  listChannelPlugins: vi.fn(),
  buildChannelUiCatalog: vi.fn(),
  resolveChannelAccountSnapshot: vi.fn(),
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
  resolveChannelAccountSnapshot: mocks.resolveChannelAccountSnapshot,
}));

vi.mock("../../infra/channel-activity.js", () => ({
  getChannelActivity: mocks.getChannelActivity,
}));

import { channelsHandlers } from "./channels.js";

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

function createChannelPlugin(
  params: {
    id?: string;
    probeAccount?: (params?: unknown) => unknown;
    buildChannelSummary?: () => unknown;
  } = {},
): ChannelTestPlugin {
  return {
    id: params.id ?? "whatsapp",
    config: {
      listAccountIds: () => ["default"],
      resolveAccount: () => ({}),
      isEnabled: () => true,
      isConfigured: async (_account, cfg) => Boolean(cfg.autoEnabled),
    },
    ...(params.probeAccount || params.buildChannelSummary
      ? {
          status: {
            ...(params.probeAccount ? { probeAccount: params.probeAccount } : {}),
            ...(params.buildChannelSummary
              ? { buildChannelSummary: params.buildChannelSummary }
              : {}),
          },
        }
      : {}),
  };
}

function configureAutoEnabledChannels(plugins: ChannelTestPlugin[]): void {
  const autoEnabledConfig = { autoEnabled: true };
  mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
  mocks.listChannelPlugins.mockReturnValue(plugins);
}

async function runChannelsStatus(
  params: Record<string, unknown>,
  overrides?: Partial<GatewayRequestHandlerOptions>,
) {
  const respond = vi.fn();
  await expectDefined(
    channelsHandlers["channels.status"],
    'channelsHandlers["channels.status"] test invariant',
  )(createOptions(params, { respond, ...overrides }));
  return requireRespondPayload(respond);
}

function channelAccounts(
  payload: Record<string, unknown>,
  channel: string,
): Record<string, unknown>[] {
  const accounts = requireRecord(payload.channelAccounts, "channel accounts")[channel] as unknown[];
  expect(Array.isArray(accounts)).toBe(true);
  return accounts.map((account) => requireRecord(account, "channel account"));
}

function firstChannelAccount(
  payload: Record<string, unknown>,
  channel: string,
): Record<string, unknown> {
  return expectDefined(
    channelAccounts(payload, channel)[0],
    "channelAccounts(payload, channel)[0] test invariant",
  );
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
  return requireRecord(call[1], "respond payload");
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
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    mocks.getChannelActivity.mockReturnValue({
      inboundAt: null,
      outboundAt: null,
    });
    mocks.listChannelPlugins.mockReturnValue([createChannelPlugin()]);
  });

  it("uses the auto-enabled config snapshot for channel account state", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 2000 });

    expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
      config: {},
    });
    const snapshotArgs = requireRecord(
      requireFirstCallArg(mocks.resolveChannelAccountSnapshot),
      "snapshot args",
    );
    expect(snapshotArgs.cfg).toBe(autoEnabledConfig);
    expect(snapshotArgs.accountId).toBe("default");
    const channels = requireRecord(payload.channels, "channels payload");
    const whatsapp = requireRecord(channels.whatsapp, "whatsapp channel");
    expect(whatsapp.configured).toBe(true);
  });

  it("redacts base URL credentials returned by channel summary hooks", async () => {
    configureAutoEnabledChannels([
      createChannelPlugin({
        buildChannelSummary: () => ({
          configured: true,
          baseUrl: [
            "https://summary-user",
            ":",
            "summary-pass",
            "@chat.example.test/?to",
            "ken=test",
          ].join(""),
        }),
      }),
    ]);

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 2000 });
    const channels = requireRecord(payload.channels, "channels payload");
    const whatsapp = requireRecord(channels.whatsapp, "whatsapp channel");
    expect(whatsapp.baseUrl).toBe("https://chat.example.test/?token=***");
  });

  it("caps probe timeout before passing it to channel plugins", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    const probeAccount = vi.fn(async () => ({ ok: true }));
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.listChannelPlugins.mockReturnValue([createChannelPlugin({ probeAccount })]);

    await expectDefined(
      channelsHandlers["channels.status"],
      'channelsHandlers["channels.status"] test invariant',
    )(createOptions({ probe: true, timeoutMs: 999_999 }));

    const probeArgs = requireRecord(requireFirstCallArg(probeAccount), "probe args");
    expect(probeArgs.timeoutMs).toBe(30_000);
    expect(probeArgs.cfg).toBe(autoEnabledConfig);
  });

  it("runs channel probes concurrently and preserves deterministic status-map order", async () => {
    vi.useFakeTimers();
    try {
      const started: string[] = [];
      const createDelayedProbe = (id: string) => async () => {
        started.push(id);
        await new Promise((resolve) => {
          setTimeout(resolve, 1000);
        });
        return { ok: true };
      };
      configureAutoEnabledChannels([
        createChannelPlugin({ id: "zeta", probeAccount: createDelayedProbe("zeta") }),
        createChannelPlugin({ id: "alpha", probeAccount: createDelayedProbe("alpha") }),
      ]);
      mocks.buildChannelUiCatalog.mockImplementation((plugins: Array<{ id: string }>) => ({
        order: plugins.map((plugin) => plugin.id),
        labels: {},
        detailLabels: {},
        systemImages: {},
        entries: {},
      }));
      const startedAt = Date.now();
      const run = runChannelsStatus({ probe: true, timeoutMs: 2000 });

      await vi.advanceTimersByTimeAsync(0);
      expect(started).toEqual(["alpha", "zeta"]);
      await vi.advanceTimersByTimeAsync(1000);
      const payload = await run;

      expect(Date.now() - startedAt).toBe(1000);
      expect(payload.channelOrder).toEqual(["zeta", "alpha"]);
      expect(Object.keys(requireRecord(payload.channels, "channels payload"))).toEqual([
        "alpha",
        "zeta",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("filters channel status to a requested channel", async () => {
    const whatsappProbe = vi.fn(async () => ({ ok: true }));
    const imessageProbe = vi.fn(async () => ({ ok: true }));
    configureAutoEnabledChannels([
      createChannelPlugin({ id: "whatsapp", probeAccount: whatsappProbe }),
      createChannelPlugin({ id: "imessage", probeAccount: imessageProbe }),
    ]);
    mocks.buildChannelUiCatalog.mockImplementation((plugins: Array<{ id: string }>) => ({
      order: plugins.map((plugin) => plugin.id),
      labels: Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.id])),
      detailLabels: Object.fromEntries(plugins.map((plugin) => [plugin.id, plugin.id])),
      systemImages: {},
      entries: Object.fromEntries(plugins.map((plugin) => [plugin.id, { id: plugin.id }])),
    }));

    const payload = await runChannelsStatus({
      channel: "imessage",
      probe: true,
      timeoutMs: 1000,
    });

    expect(whatsappProbe).not.toHaveBeenCalled();
    expect(imessageProbe).toHaveBeenCalledOnce();
    expect(payload.channelOrder).toEqual(["imessage"]);
    expect(payload.channels).toEqual({
      imessage: { configured: true },
    });
    expect(payload.channelAccounts).toEqual({
      imessage: [
        {
          accountId: "default",
          configured: true,
          lastProbeAt: expect.any(Number),
          lastInboundAt: null,
          lastOutboundAt: null,
          healthState: "not-running",
        },
      ],
    });
  });

  it("preserves channel account rows when a live probe throws", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    const probeAccount = vi.fn(async () => {
      throw new Error("probe failed");
    });
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.resolveChannelAccountSnapshot.mockImplementation(async ({ accountId, probe }) => ({
      accountId,
      configured: true,
      probe,
    }));
    mocks.listChannelPlugins.mockReturnValue([createChannelPlugin({ probeAccount })]);

    const payload = await runChannelsStatus({ probe: true, timeoutMs: 1000 });

    const account = firstChannelAccount(payload, "whatsapp");
    expect(account.accountId).toBe("default");
    expect(String(account.lastError)).toContain("probe failed");
    expect(typeof account.lastProbeAt).toBe("number");
    const accountProbe = requireRecord(account.probe, "account probe");
    expect(accountProbe.ok).toBe(false);
    expect(String(accountProbe.error)).toContain("probe failed");
  });

  it("isolates a timed-out channel probe while another channel succeeds", async () => {
    vi.useFakeTimers();
    try {
      const autoEnabledConfig = { autoEnabled: true };
      const hangingProbe = vi.fn(() => new Promise(() => {}));
      const healthyProbe = vi.fn(async () => ({ ok: true, identity: "healthy" }));
      mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
      mocks.listChannelPlugins.mockReturnValue([
        createChannelPlugin({ id: "hanging", probeAccount: hangingProbe }),
        createChannelPlugin({ id: "healthy", probeAccount: healthyProbe }),
      ]);
      mocks.resolveChannelAccountSnapshot.mockImplementation(async ({ accountId, probe }) => ({
        accountId,
        configured: true,
        probe,
      }));
      const respond = vi.fn();
      const run = expectDefined(
        channelsHandlers["channels.status"],
        'channelsHandlers["channels.status"] test invariant',
      )(createOptions({ probe: true, timeoutMs: 1000 }, { respond }));

      await vi.advanceTimersByTimeAsync(1000);
      await run;

      const payload = requireRespondPayload(respond);
      expect(
        requireRecord(firstChannelAccount(payload, "hanging").probe, "hanging probe").timedOut,
      ).toBe(true);
      expect(requireRecord(firstChannelAccount(payload, "healthy").probe, "healthy probe")).toEqual(
        {
          ok: true,
          identity: "healthy",
        },
      );
      expect(payload.partial).toBe(true);
      expect(payload.warnings).toEqual(["hanging:default probe timed out after 1000ms"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("falls back to account-derived channel summaries when summary building fails", async () => {
    const autoEnabledConfig = { autoEnabled: true };
    mocks.applyPluginAutoEnable.mockReturnValue({ config: autoEnabledConfig, changes: [] });
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      configured: true,
    });
    mocks.listChannelPlugins.mockReturnValue([
      createChannelPlugin({
        buildChannelSummary: async () => {
          throw new Error("summary failed");
        },
      }),
    ]);

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 1000 });
    const channels = requireRecord(payload.channels, "channels payload");
    const whatsapp = requireRecord(channels.whatsapp, "whatsapp channel");
    expect(whatsapp.configured).toBe(true);
    expect(String(whatsapp.lastError)).toContain("summary failed");

    const account = firstChannelAccount(payload, "whatsapp");
    expect(account.accountId).toBe("default");
    expect(account.configured).toBe(true);
  });

  it("annotates terminal-disconnect accounts with terminal-disconnect health state", async () => {
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      running: false,
      terminalDisconnect: true,
    });
    const respond = vi.fn();

    await expectDefined(
      channelsHandlers["channels.status"],
      'channelsHandlers["channels.status"] test invariant',
    )(createOptions({ probe: false, timeoutMs: 2000 }, { respond }));

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        channelAccounts: {
          whatsapp: [
            expect.objectContaining({
              healthState: "terminal-disconnect",
            }),
          ],
        },
      }),
      undefined,
    );
  });

  it("annotates unhealthy channel snapshots and includes event-loop health", async () => {
    const now = Date.now();
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      healthState: "stale",
      lastStartAt: now - 60 * 60_000,
      lastTransportActivityAt: now - 40 * 60_000,
    });
    const eventLoop = {
      degraded: true,
      degradedSinceMs: 61_000,
      reasons: ["event_loop_delay"],
      intervalMs: 62_000,
      delayP99Ms: 62_000,
      delayMaxMs: 62_000,
      utilization: 1,
      cpuCoreRatio: 1,
    };
    const respond = vi.fn();

    await expectDefined(
      channelsHandlers["channels.status"],
      'channelsHandlers["channels.status"] test invariant',
    )(
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
    expect(firstChannelAccount(payload, "whatsapp").healthState).toBe("stale-socket");
  });

  it("preserves channel-authored health state when shared health is healthy", async () => {
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      healthState: "reconnecting",
    });

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 2000 });

    expect(firstChannelAccount(payload, "whatsapp").healthState).toBe("reconnecting");
  });

  it("preserves channel-authored conflict when recorded blocked lifecycle is unhealthy", async () => {
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      linked: true,
      running: false,
      connected: false,
      terminalDisconnect: true,
      lifecycle: "blocked",
      healthState: "conflict",
      lastError: "status=440",
    });

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 2000 });

    expect(firstChannelAccount(payload, "whatsapp")).toMatchObject({
      lifecycle: "blocked",
      healthState: "conflict",
      terminalDisconnect: true,
    });
  });

  it("derives blocked health from recorded lifecycle", async () => {
    mocks.applyPluginAutoEnable.mockReturnValue({ config: { autoEnabled: true }, changes: [] });
    mocks.resolveChannelAccountSnapshot.mockResolvedValue({
      accountId: "default",
      enabled: true,
      configured: true,
      running: true,
      connected: true,
      lifecycle: "blocked",
      lastError: "Slack identity unavailable",
    });

    const payload = await runChannelsStatus({ probe: false, timeoutMs: 2000 });

    expect(firstChannelAccount(payload, "whatsapp")).toMatchObject({
      lifecycle: "blocked",
      healthState: "blocked",
    });
  });
});

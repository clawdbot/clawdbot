import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type ChannelGatewayContext,
  type ChannelId,
  type ChannelPlugin,
} from "../channels/plugins/types.js";
import {
  createSubsystemLogger,
  type SubsystemLogger,
  runtimeForLogger,
} from "../logging/subsystem.js";
import { createEmptyPluginRegistry, type PluginRegistry } from "../plugins/registry.js";
import { getActivePluginRegistry, setActivePluginRegistry } from "../plugins/runtime.js";
import { createRuntimeChannel } from "../plugins/runtime/runtime-channel.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { createChannelManager } from "./server-channels.js";

const hoisted = vi.hoisted(() => {
  const computeBackoff = vi.fn(() => 10);
  const sleepWithAbort = vi.fn((ms: number, abortSignal?: AbortSignal) => {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), ms);
      abortSignal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          reject(new Error("aborted"));
        },
        { once: true },
      );
    });
  });
  return { computeBackoff, sleepWithAbort };
});

vi.mock("../infra/backoff.js", () => ({
  computeBackoff: hoisted.computeBackoff,
  sleepWithAbort: hoisted.sleepWithAbort,
}));

type TestAccount = {
  enabled?: boolean;
  configured?: boolean;
};

function createTestPlugin(params?: {
  id?: ChannelId;
  order?: number;
  account?: TestAccount;
  startAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["startAccount"];
  includeDescribeAccount?: boolean;
  describeAccount?: ChannelPlugin<TestAccount>["config"]["describeAccount"];
  resolveAccount?: ChannelPlugin<TestAccount>["config"]["resolveAccount"];
  isConfigured?: ChannelPlugin<TestAccount>["config"]["isConfigured"];
}): ChannelPlugin<TestAccount> {
  const id = params?.id ?? "discord";
  const account = params?.account ?? { enabled: true, configured: true };
  const includeDescribeAccount = params?.includeDescribeAccount !== false;
  const config: ChannelPlugin<TestAccount>["config"] = {
    listAccountIds: () => [DEFAULT_ACCOUNT_ID],
    resolveAccount: params?.resolveAccount ?? (() => account),
    isEnabled: (resolved) => resolved.enabled !== false,
    ...(params?.isConfigured ? { isConfigured: params.isConfigured } : {}),
  };
  if (includeDescribeAccount) {
    config.describeAccount =
      params?.describeAccount ??
      ((resolved) => ({
        accountId: DEFAULT_ACCOUNT_ID,
        enabled: resolved.enabled !== false,
        configured: resolved.configured !== false,
      }));
  }
  const gateway: NonNullable<ChannelPlugin<TestAccount>["gateway"]> = {};
  if (params?.startAccount) {
    gateway.startAccount = params.startAccount;
  }
  return {
    id,
    meta: {
      id,
      label: id,
      selectionLabel: id,
      docsPath: `/channels/${id}`,
      blurb: "test stub",
      ...(params?.order === undefined ? {} : { order: params.order }),
    },
    capabilities: { chatTypes: ["direct"] },
    config,
    gateway,
  };
}

function createDeferred(): { promise: Promise<void>; resolve: () => void } {
  let resolvePromise = () => {};
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function installTestRegistry(...plugins: ChannelPlugin<TestAccount>[]) {
  const registry = createEmptyPluginRegistry();
  for (const plugin of plugins) {
    registry.channels.push({
      pluginId: plugin.id,
      source: "test",
      plugin,
    });
  }
  setActivePluginRegistry(registry);
}

function createManager(options?: {
  channelRuntime?: PluginRuntime["channel"];
  resolveChannelRuntime?: () => PluginRuntime["channel"];
  loadConfig?: () => Record<string, unknown>;
  channelIds?: ChannelId[];
}) {
  const log = createSubsystemLogger("gateway/server-channels-test");
  const channelLogs = { discord: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime } as unknown as Record<ChannelId, RuntimeEnv>;
  const channelIds = options?.channelIds ?? ["discord"];
  for (const channelId of channelIds) {
    channelLogs[channelId] ??= log.child(channelId);
    channelRuntimeEnvs[channelId] ??= runtime;
  }
  return createChannelManager({
    loadConfig: () => options?.loadConfig?.() ?? {},
    channelLogs,
    channelRuntimeEnvs,
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
    ...(options?.resolveChannelRuntime
      ? { resolveChannelRuntime: options.resolveChannelRuntime }
      : {}),
  });
}

describe("server-channels auto restart", () => {
  let previousRegistry: PluginRegistry | null = null;

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    vi.useFakeTimers();
    hoisted.computeBackoff.mockClear();
    hoisted.sleepWithAbort.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    setActivePluginRegistry(previousRegistry ?? createEmptyPluginRegistry());
  });

  it("caps crash-loop restarts after max attempts", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);

    expect(startAccount).toHaveBeenCalledTimes(11);
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.reconnectAttempts).toBe(11);

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(11);
  });

  it("does not auto-restart after manual stop during backoff", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    vi.runAllTicks();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("marks enabled/configured when account descriptors omit them", () => {
    installTestRegistry(
      createTestPlugin({
        includeDescribeAccount: false,
      }),
    );
    const manager = createManager();
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.enabled).toBe(true);
    expect(account?.configured).toBe(true);
  });

  it("applies described config fields into runtime snapshots", () => {
    installTestRegistry(
      createTestPlugin({
        describeAccount: (resolved) => ({
          accountId: DEFAULT_ACCOUNT_ID,
          enabled: resolved.enabled !== false,
          configured: false,
          mode: "webhook",
        }),
      }),
    );
    const manager = createManager();
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.configured).toBe(false);
    expect(account?.mode).toBe("webhook");
  });

  it("passes channelRuntime through channel gateway context when provided", async () => {
    const channelRuntime = {
      ...createRuntimeChannel(),
      marker: "channel-runtime",
    } as PluginRuntime["channel"] & { marker: string };
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ channelRuntime });

    await manager.startChannels();
    expect(startAccount).toHaveBeenCalledTimes(1);
    const [ctx] = startAccount.mock.calls[0] ?? [];
    expect(ctx?.channelRuntime).toMatchObject({ marker: "channel-runtime" });
    expect(ctx?.channelRuntime).not.toBe(channelRuntime);
  });

  it("deduplicates concurrent start requests for the same account", async () => {
    const startupGate = createDeferred();
    const isConfigured = vi.fn(async () => {
      await startupGate.promise;
      return true;
    });
    const startAccount = vi.fn(async () => {});

    installTestRegistry(createTestPlugin({ startAccount, isConfigured }));
    const manager = createManager();

    const firstStart = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    const secondStart = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    await Promise.resolve();
    expect(isConfigured).toHaveBeenCalledTimes(1);
    expect(startAccount).not.toHaveBeenCalled();

    startupGate.resolve();
    await Promise.all([firstStart, secondStart]);

    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("cancels a pending startup when the account is stopped mid-boot", async () => {
    const startupGate = createDeferred();
    const isConfigured = vi.fn(async () => {
      await startupGate.promise;
      return true;
    });
    const startAccount = vi.fn(async () => {});

    installTestRegistry(createTestPlugin({ startAccount, isConfigured }));
    const manager = createManager();

    const startTask = manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await Promise.resolve();

    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    startupGate.resolve();

    await Promise.all([startTask, stopTask]);

    expect(startAccount).not.toHaveBeenCalled();
  });

  it("does not resolve channelRuntime until a channel starts", async () => {
    const channelRuntime = {
      ...createRuntimeChannel(),
      marker: "lazy-channel-runtime",
    } as PluginRuntime["channel"] & { marker: string };
    const resolveChannelRuntime = vi.fn(() => channelRuntime);
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ resolveChannelRuntime });

    expect(resolveChannelRuntime).not.toHaveBeenCalled();

    void manager.getRuntimeSnapshot();
    expect(resolveChannelRuntime).not.toHaveBeenCalled();

    await manager.startChannels();

    expect(resolveChannelRuntime).toHaveBeenCalledTimes(1);
    expect(startAccount).toHaveBeenCalledTimes(1);
    const [ctx] = startAccount.mock.calls[0] ?? [];
    expect(ctx?.channelRuntime).toMatchObject({ marker: "lazy-channel-runtime" });
    expect(ctx?.channelRuntime).not.toBe(channelRuntime);
  });

  it("fails fast when channelRuntime is not a full plugin runtime surface", async () => {
    installTestRegistry(createTestPlugin({ startAccount: vi.fn(async () => {}) }));
    const manager = createManager({
      channelRuntime: { marker: "partial-runtime" } as unknown as PluginRuntime["channel"],
    });

    await expect(manager.startChannel("discord", DEFAULT_ACCOUNT_ID)).rejects.toThrow(
      "channelRuntime must provide runtimeContexts.register/get/watch; pass createPluginRuntime().channel or omit channelRuntime.",
    );
    await expect(manager.startChannel("discord", DEFAULT_ACCOUNT_ID)).rejects.toThrow(
      "channelRuntime must provide runtimeContexts.register/get/watch; pass createPluginRuntime().channel or omit channelRuntime.",
    );
  });

  it("keeps auto-restart running when scoped runtime cleanup throws", async () => {
    const baseChannelRuntime = createRuntimeChannel();
    const channelRuntime: PluginRuntime["channel"] = {
      ...baseChannelRuntime,
      runtimeContexts: {
        ...baseChannelRuntime.runtimeContexts,
        register: () => ({
          dispose: () => {
            throw new Error("cleanup boom");
          },
        }),
      },
    };
    const startAccount = vi.fn(async ({ channelRuntime }: ChannelGatewayContext<TestAccount>) => {
      channelRuntime?.runtimeContexts.register({
        channelId: "discord",
        accountId: DEFAULT_ACCOUNT_ID,
        capability: "approval.native",
        context: { token: "tracked" },
      });
    });

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ channelRuntime });

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(30);

    expect(startAccount.mock.calls.length).toBeGreaterThan(1);
  });

  it("continues starting later channels after one startup failure", async () => {
    const failingStart = vi.fn(async () => {
      throw new Error("missing runtime");
    });
    const succeedingStart = vi.fn(async () => {});
    installTestRegistry(
      createTestPlugin({ id: "discord", order: 1, startAccount: failingStart }),
      createTestPlugin({ id: "slack", order: 2, startAccount: succeedingStart }),
    );
    const manager = createManager({ channelIds: ["discord", "slack"] });

    await expect(manager.startChannels()).resolves.toBeUndefined();

    expect(failingStart).toHaveBeenCalledTimes(1);
    expect(succeedingStart).toHaveBeenCalledTimes(1);
  });

  it("reuses plugin account resolution for health monitor overrides", () => {
    installTestRegistry(
      createTestPlugin({
        resolveAccount: (cfg, accountId) => {
          const accounts = (
            cfg as {
              channels?: {
                discord?: {
                  accounts?: Record<
                    string,
                    TestAccount & { healthMonitor?: { enabled?: boolean } }
                  >;
                };
              };
            }
          ).channels?.discord?.accounts;
          if (!accounts) {
            return { enabled: true, configured: true };
          }
          const direct = accounts[accountId ?? DEFAULT_ACCOUNT_ID];
          if (direct) {
            return direct;
          }
          const normalized = (accountId ?? DEFAULT_ACCOUNT_ID).toLowerCase().replaceAll(" ", "-");
          const matchKey = Object.keys(accounts).find(
            (key) => key.toLowerCase().replaceAll(" ", "-") === normalized,
          );
          return matchKey ? (accounts[matchKey] ?? { enabled: true, configured: true }) : {};
        },
      }),
    );

    const manager = createManager({
      loadConfig: () => ({
        channels: {
          discord: {
            accounts: {
              "Router D": {
                enabled: true,
                configured: true,
                healthMonitor: { enabled: false },
              },
            },
          },
        },
      }),
    });

    expect(manager.isHealthMonitorEnabled("discord", "router-d")).toBe(false);
  });

  it("falls back to channel-level health monitor overrides when account resolution omits them", () => {
    installTestRegistry(
      createTestPlugin({
        resolveAccount: () => ({
          enabled: true,
          configured: true,
        }),
      }),
    );

    const manager = createManager({
      loadConfig: () => ({
        channels: {
          discord: {
            healthMonitor: { enabled: false },
          },
        },
      }),
    });

    expect(manager.isHealthMonitorEnabled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
  });

  it("uses raw account config overrides when resolvers omit health monitor fields", () => {
    installTestRegistry(
      createTestPlugin({
        resolveAccount: () => ({
          enabled: true,
          configured: true,
        }),
      }),
    );

    const manager = createManager({
      loadConfig: () => ({
        channels: {
          discord: {
            accounts: {
              [DEFAULT_ACCOUNT_ID]: {
                healthMonitor: { enabled: false },
              },
            },
          },
        },
      }),
    });

    expect(manager.isHealthMonitorEnabled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
  });

  it("fails closed when account resolution throws during health monitor gating", () => {
    installTestRegistry(
      createTestPlugin({
        resolveAccount: () => {
          throw new Error("unresolved SecretRef");
        },
      }),
    );

    const manager = createManager();

    expect(manager.isHealthMonitorEnabled("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
  });

  it("does not treat an empty account id as the default account when matching raw overrides", () => {
    installTestRegistry(
      createTestPlugin({
        resolveAccount: () => ({
          enabled: true,
          configured: true,
        }),
      }),
    );

    const manager = createManager({
      loadConfig: () => ({
        channels: {
          discord: {
            accounts: {
              default: {
                healthMonitor: { enabled: false },
              },
            },
          },
        },
      }),
    });

    expect(manager.isHealthMonitorEnabled("discord", "")).toBe(true);
  });
});

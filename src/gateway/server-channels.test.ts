import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
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
import { createChannelRuntimeContextRegistry } from "../plugins/runtime/channel-runtime-contexts.js";
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
  listAccountIds?: ChannelPlugin<TestAccount>["config"]["listAccountIds"];
  includeDescribeAccount?: boolean;
  describeAccount?: ChannelPlugin<TestAccount>["config"]["describeAccount"];
  resolveAccount?: ChannelPlugin<TestAccount>["config"]["resolveAccount"];
  isConfigured?: ChannelPlugin<TestAccount>["config"]["isConfigured"];
}): ChannelPlugin<TestAccount> {
  const id = params?.id ?? "discord";
  const account = params?.account ?? { enabled: true, configured: true };
  const includeDescribeAccount = params?.includeDescribeAccount !== false;
  const config: ChannelPlugin<TestAccount>["config"] = {
    listAccountIds: params?.listAccountIds ?? (() => [DEFAULT_ACCOUNT_ID]),
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

async function flushMicrotasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await Promise.resolve();
  }
}

async function waitForMicrotaskCondition(
  check: () => boolean,
  message: string,
  attempts = 100,
): Promise<void> {
  for (let i = 0; i < attempts; i += 1) {
    if (check()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(message);
}

function firstSleepWithAbortCall(): [number, AbortSignal | undefined] {
  const call = hoisted.sleepWithAbort.mock.calls[0];
  if (!call) {
    throw new Error("expected sleepWithAbort call");
  }
  return call as [number, AbortSignal | undefined];
}

function firstStartAccountContext(
  startAccount: ReturnType<typeof vi.fn>,
): ChannelGatewayContext<TestAccount> {
  const ctx = startAccount.mock.calls[0]?.[0];
  if (!ctx || typeof ctx !== "object") {
    throw new Error("expected channel start context");
  }
  return ctx as ChannelGatewayContext<TestAccount>;
}

function installTestRegistry(
  ...plugins: Array<
    ChannelPlugin<TestAccount> | { plugin: ChannelPlugin<TestAccount>; origin: string }
  >
) {
  const registry = createEmptyPluginRegistry();
  for (const candidate of plugins) {
    const plugin = "plugin" in candidate ? candidate.plugin : candidate;
    registry.channels.push({
      pluginId: plugin.id,
      ...("origin" in candidate ? { origin: candidate.origin as never } : {}),
      source: "test",
      plugin,
    });
  }
  setActivePluginRegistry(registry);
}

function createManager(options?: {
  channelRuntime?: ChannelRuntimeSurface;
  resolveChannelRuntime?: () => ChannelRuntimeSurface | Promise<ChannelRuntimeSurface>;
  resolveStartupChannelRuntime?: () => ChannelRuntimeSurface | Promise<ChannelRuntimeSurface>;
  getRuntimeConfig?: () => Record<string, unknown>;
  channelIds?: ChannelId[];
  startupTrace?: { measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T> };
  fillChannelDependencies?: boolean;
}) {
  const log = createSubsystemLogger("gateway/server-channels-test");
  const channelLogs = { discord: log } as Record<ChannelId, SubsystemLogger>;
  const runtime = runtimeForLogger(log);
  const channelRuntimeEnvs = { discord: runtime } as unknown as Record<ChannelId, RuntimeEnv>;
  const channelIds = options?.channelIds ?? ["discord"];
  if (options?.fillChannelDependencies !== false) {
    for (const channelId of channelIds) {
      channelLogs[channelId] ??= log.child(channelId);
      channelRuntimeEnvs[channelId] ??= runtime;
    }
  }
  return createChannelManager({
    getRuntimeConfig: () => options?.getRuntimeConfig?.() ?? {},
    channelLogs,
    channelRuntimeEnvs,
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
    ...(options?.resolveChannelRuntime
      ? { resolveChannelRuntime: options.resolveChannelRuntime }
      : {}),
    ...(options?.resolveStartupChannelRuntime
      ? { resolveStartupChannelRuntime: options.resolveStartupChannelRuntime }
      : {}),
    ...(options?.startupTrace ? { startupTrace: options.startupTrace } : {}),
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
    expect(account?.lastError).toBe("channel exited without an error");

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(11);
  });

  it("records a clean channel monitor exit before auto-restart", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(0);

    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalled();
    expect(account?.running).toBe(false);
    expect(account?.restartPending).toBe(true);
    expect(account?.lastError).toBe("channel exited without an error");
  });

  it("does not record a clean-exit error for manual abort stops", async () => {
    const startAccount = vi.fn(
      async ({ abortSignal }: { abortSignal: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);

    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.lastError).toBeNull();
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

  it("consumes rejected stop tasks during manual abort", async () => {
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      const startAccount = vi.fn(
        async ({ abortSignal }: { abortSignal: AbortSignal }) =>
          await new Promise<void>((_resolve, reject) => {
            abortSignal.addEventListener(
              "abort",
              () => {
                reject(new Error("aborted"));
              },
              { once: true },
            );
          }),
      );
      installTestRegistry(
        createTestPlugin({
          startAccount,
        }),
      );
      const manager = createManager();

      await manager.startChannels();
      vi.runAllTicks();
      await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
      await Promise.resolve();

      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it("does not allow a second account task to start when stop times out", async () => {
    const startAccount = vi.fn(
      async ({ abortSignal }: { abortSignal: AbortSignal }) =>
        await new Promise<void>(() => {
          abortSignal.addEventListener("abort", () => {}, { once: true });
        }),
    );
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopTask;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(true);
    expect(account?.restartPending).toBe(false);
    expect(account?.lastError).toContain("channel stop timed out");
  });

  it("does not poison auto-restart state when recovery stop times out", async () => {
    const releaseFirstTask = createDeferred();
    const startAccount = vi.fn(
      async ({ abortSignal }: { abortSignal: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => {}, { once: true });
          void releaseFirstTask.promise.then(resolve);
        }),
    );
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false });
    await vi.advanceTimersByTimeAsync(5_000);
    await stopTask;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.restartPending).toBe(true);
    expect(account?.lastError).toContain("channel stop timed out");
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(false);

    releaseFirstTask.resolve();
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    expect(startAccount).toHaveBeenCalledTimes(2);
  });

  it("lets manual stops cancel recovery backoff after recovery stop times out", async () => {
    const releaseFirstTask = createDeferred();
    const startAccount = vi.fn(
      async ({ abortSignal }: { abortSignal: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => {}, { once: true });
          void releaseFirstTask.promise.then(resolve);
        }),
    );
    installTestRegistry(
      createTestPlugin({
        startAccount,
      }),
    );
    const manager = createManager();

    await manager.startChannels();
    const recoveryStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
      manual: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await recoveryStopTask;

    releaseFirstTask.resolve();
    await waitForMicrotaskCondition(
      () => hoisted.sleepWithAbort.mock.calls.length > 0,
      "expected recovery restart backoff to be scheduled",
    );
    const sleepCall = firstSleepWithAbortCall();
    expect(sleepCall[0]).toBe(10);
    expect(sleepCall[1]).toBeInstanceOf(AbortSignal);

    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.restartPending).toBe(false);
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
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
    const ctx = firstStartAccountContext(startAccount);
    expect((ctx?.channelRuntime as { marker?: string } | undefined)?.marker).toBe(
      "channel-runtime",
    );
    expect(ctx?.channelRuntime).not.toBe(channelRuntime);
  });

  it("creates formatted runtime and log sinks for channels loaded after manager construction", async () => {
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});
    installTestRegistry(createTestPlugin({ id: "slack", startAccount }));
    const channelLogs = {} as Record<ChannelId, SubsystemLogger>;
    const channelRuntimeEnvs = {} as Record<ChannelId, RuntimeEnv>;
    const manager = createChannelManager({
      getRuntimeConfig: () => ({}),
      channelLogs,
      channelRuntimeEnvs,
    });

    await manager.startChannel("slack");

    expect(startAccount).toHaveBeenCalledTimes(1);
    const ctx = firstStartAccountContext(startAccount);
    expect(ctx?.log).toBe(channelLogs.slack);
    expect(ctx?.runtime).toBe(channelRuntimeEnvs.slack);
    expect((ctx?.log as SubsystemLogger | undefined)?.subsystem).toBe("channels/slack");
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
    const ctx = firstStartAccountContext(startAccount);
    expect((ctx?.channelRuntime as { marker?: string } | undefined)?.marker).toBe(
      "lazy-channel-runtime",
    );
    expect(ctx?.channelRuntime).not.toBe(channelRuntime);
  });

  it("uses a lightweight startup runtime for bundled channels", async () => {
    const fullRuntime = {
      ...createRuntimeChannel(),
      marker: "full-channel-runtime",
    } as PluginRuntime["channel"] & { marker: string };
    const startupRuntime = {
      runtimeContexts: createChannelRuntimeContextRegistry(),
      marker: "startup-channel-runtime",
    };
    const resolveChannelRuntime = vi.fn(() => fullRuntime);
    const resolveStartupChannelRuntime = vi.fn(() => startupRuntime);
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});

    installTestRegistry({ plugin: createTestPlugin({ startAccount }), origin: "bundled" });
    const manager = createManager({ resolveChannelRuntime, resolveStartupChannelRuntime });

    await manager.startChannels();

    expect(resolveStartupChannelRuntime).toHaveBeenCalledTimes(1);
    expect(resolveChannelRuntime).not.toHaveBeenCalled();
    expect(startAccount).toHaveBeenCalledTimes(1);
    const ctx = firstStartAccountContext(startAccount);
    expect((ctx?.channelRuntime as { marker?: string } | undefined)?.marker).toBe(
      "startup-channel-runtime",
    );
    expect(ctx?.channelRuntime).not.toBe(startupRuntime);
  });

  it("keeps the full runtime path for non-bundled channels", async () => {
    const fullRuntime = {
      ...createRuntimeChannel(),
      marker: "full-channel-runtime",
    } as PluginRuntime["channel"] & { marker: string };
    const startupRuntime = {
      runtimeContexts: createChannelRuntimeContextRegistry(),
      marker: "startup-channel-runtime",
    };
    const resolveChannelRuntime = vi.fn(() => fullRuntime);
    const resolveStartupChannelRuntime = vi.fn(() => startupRuntime);
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});

    installTestRegistry({ plugin: createTestPlugin({ startAccount }), origin: "workspace" });
    const manager = createManager({ resolveChannelRuntime, resolveStartupChannelRuntime });

    await manager.startChannels();

    expect(resolveStartupChannelRuntime).not.toHaveBeenCalled();
    expect(resolveChannelRuntime).toHaveBeenCalledTimes(1);
    const ctx = firstStartAccountContext(startAccount);
    expect((ctx?.channelRuntime as { marker?: string } | undefined)?.marker).toBe(
      "full-channel-runtime",
    );
  });

  it("does not resolve channelRuntime for disabled accounts", async () => {
    const channelRuntime = createRuntimeChannel();
    const resolveChannelRuntime = vi.fn(() => channelRuntime);
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});

    installTestRegistry(
      createTestPlugin({
        startAccount,
        account: { enabled: false, configured: true },
      }),
    );
    const manager = createManager({ resolveChannelRuntime });

    await manager.startChannels();

    expect(resolveChannelRuntime).not.toHaveBeenCalled();
    expect(startAccount).not.toHaveBeenCalled();
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

  it("uses fallback logger and runtime when a channel is missing startup wiring", async () => {
    const startAccount = vi.fn(async () => {
      throw new Error("invalid_auth");
    });
    installTestRegistry(createTestPlugin({ id: "slack", startAccount }));
    const manager = createManager({ channelIds: ["slack"], fillChannelDependencies: false });

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(0);

    expect(startAccount).toHaveBeenCalledTimes(1);
    const account = manager.getRuntimeSnapshot().channelAccounts.slack?.[DEFAULT_ACCOUNT_ID];
    expect(account?.lastError).toBe("invalid_auth");
  });

  it("emits startup trace spans for channel preflight and handoff", async () => {
    const measureMock = vi.fn(async (name: string, run: () => unknown) => await run());
    const startupTrace = {
      measure: async <T>(name: string, run: () => T | Promise<T>) =>
        (await measureMock(name, run)) as T,
    };
    const startAccount = vi.fn(async () => {});

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ startupTrace });

    await manager.startChannels();

    const names = measureMock.mock.calls.map(([name]) => name);
    expect(names).toContain("channels.discord.start");
    expect(names).toContain("channels.discord.list-accounts");
    expect(names).toContain("channels.discord.runtime");
    expect(names).toContain("channels.discord.approval-bootstrap");
  });

  it("limits whole-channel account startup fanout to four", async () => {
    const accountIds = ["one", "two", "three", "four", "five", "six"];
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const isConfigured = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => {
        releases.push(resolve);
      });
      active -= 1;
      return true;
    });
    const startAccount = vi.fn(
      async ({ abortSignal }: { abortSignal: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    installTestRegistry(
      createTestPlugin({
        listAccountIds: () => accountIds,
        isConfigured,
        startAccount,
      }),
    );
    const manager = createManager();

    const start = manager.startChannel("discord");
    await flushMicrotasks();

    expect(isConfigured).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(4);
    expect(startAccount).not.toHaveBeenCalled();

    releases.splice(0, 4).forEach((release) => release());
    await waitForMicrotaskCondition(
      () => isConfigured.mock.calls.length === 6,
      "expected second account startup wave",
    );

    expect(isConfigured).toHaveBeenCalledTimes(6);
    expect(maxActive).toBe(4);

    releases.splice(0).forEach((release) => release());
    await start;
    expect(startAccount).toHaveBeenCalledTimes(6);

    await manager.stopChannel("discord");
  });

  it("limits channel plugin startup fanout to four", async () => {
    const channelIds = Array.from({ length: 6 }, (_, index) => `test-${index}` as ChannelId);
    const releases: Array<() => void> = [];
    let active = 0;
    let maxActive = 0;
    const plugins = channelIds.map((id, index) =>
      createTestPlugin({
        id,
        order: index,
        isConfigured: async () => {
          active += 1;
          maxActive = Math.max(maxActive, active);
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
          active -= 1;
          return true;
        },
        startAccount: async ({ abortSignal }) =>
          await new Promise<void>((resolve) => {
            abortSignal.addEventListener("abort", () => resolve(), { once: true });
          }),
      }),
    );
    installTestRegistry(...plugins);
    const manager = createManager({ channelIds });

    const start = manager.startChannels();
    await flushMicrotasks();

    expect(releases).toHaveLength(4);
    expect(maxActive).toBe(4);

    releases.splice(0, 4).forEach((release) => release());
    await waitForMicrotaskCondition(
      () => releases.length === 2,
      "expected second channel startup wave",
    );

    expect(releases).toHaveLength(2);
    expect(maxActive).toBe(4);

    releases.splice(0).forEach((release) => release());
    await start;

    await Promise.all(channelIds.map((id) => manager.stopChannel(id)));
  });

  it("evicts stale account lifecycle state during whole-channel reload", async () => {
    let accountIds = [DEFAULT_ACCOUNT_ID];
    const startAccount = vi.fn(
      async ({ abortSignal }: { abortSignal: AbortSignal }) =>
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    installTestRegistry(createTestPlugin({ startAccount, listAccountIds: () => accountIds }));
    const manager = createManager();

    await manager.startChannel("discord");

    accountIds = [];
    await manager.stopChannel("discord");
    await manager.startChannel("discord");

    accountIds = [DEFAULT_ACCOUNT_ID];
    await manager.startChannel("discord");

    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(account?.reconnectAttempts).toBe(0);
    expect(account?.lastStopAt).toBeUndefined();

    await manager.stopChannel("discord");
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
      getRuntimeConfig: () => ({
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
      getRuntimeConfig: () => ({
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
      getRuntimeConfig: () => ({
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
      getRuntimeConfig: () => ({
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

/**
 * Server channel lifecycle tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type { ChannelId, ChannelPlugin } from "../channels/plugins/types.public.js";
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
import {
  listActiveDegradedSecretOwners,
  setActiveDegradedSecretOwners,
} from "../secrets/runtime-degraded-state.js";
import { createChannelManager, type ChannelManager } from "./server-channels.js";

const hoisted = vi.hoisted(() => {
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
  const startChannelApprovalHandlerBootstrap = vi.fn(async () => async () => {});
  return { sleepWithAbort, startChannelApprovalHandlerBootstrap };
});

vi.mock("../../packages/retry/src/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../packages/retry/src/index.js")>();
  class TestRetrySupervisor extends actual.RetrySupervisor {
    constructor(
      _policy: ConstructorParameters<typeof actual.RetrySupervisor>[0],
      maxAttempts?: number,
    ) {
      super({ initialMs: 10, maxMs: 10, factor: 1, jitter: 0 }, maxAttempts);
    }
  }
  return {
    ...actual,
    RetrySupervisor: TestRetrySupervisor,
  };
});

vi.mock("../infra/backoff.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/backoff.js")>();
  return {
    ...actual,
    sleepWithAbort: hoisted.sleepWithAbort,
  };
});

vi.mock("../infra/approval-handler-bootstrap.js", () => ({
  startChannelApprovalHandlerBootstrap: hoisted.startChannelApprovalHandlerBootstrap,
}));

type TestAccount = {
  enabled?: boolean;
  configured?: boolean;
  credentialDiagnostics?: Array<{
    code: "CREDENTIAL_FILE_UNAVAILABLE";
    path: string;
    reason: string;
  }>;
};

const createdManagers: Array<{ manager: ChannelManager; channelIds: ChannelId[] }> = [];

function createTestPlugin(params?: {
  id?: ChannelId;
  order?: number;
  account?: TestAccount;
  startAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["startAccount"];
  stopAccount?: NonNullable<ChannelPlugin<TestAccount>["gateway"]>["stopAccount"];
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
  if (params?.stopAccount) {
    gateway.stopAccount = params.stopAccount;
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

async function waitForImmediate(): Promise<void> {
  await new Promise<void>((resolve) => {
    const handle = setImmediate(resolve);
    handle.unref?.();
  });
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

async function advanceTimersUntil(
  check: () => boolean,
  message: string,
  options: { stepMs: number; maxMs: number },
): Promise<void> {
  for (let elapsed = 0; elapsed <= options.maxMs; elapsed += options.stepMs) {
    if (check()) {
      return;
    }
    await vi.advanceTimersByTimeAsync(options.stepMs);
    await flushMicrotasks();
  }
  if (check()) {
    return;
  }
  throw new Error(message);
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
  channelRuntime?: PluginRuntime["channel"];
  resolveChannelRuntime?: () => PluginRuntime["channel"] | Promise<PluginRuntime["channel"]>;
  getRuntimeConfig?: () => Record<string, unknown>;
  channelIds?: ChannelId[];
  startupTrace?: { measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T> };
  deferStartupAccountStartsUntil?: Promise<void>;
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
  const manager = createChannelManager({
    getRuntimeConfig: () => options?.getRuntimeConfig?.() ?? {},
    channelLogs,
    channelRuntimeEnvs,
    ...(options?.channelRuntime ? { channelRuntime: options.channelRuntime } : {}),
    ...(options?.resolveChannelRuntime
      ? { resolveChannelRuntime: options.resolveChannelRuntime }
      : {}),
    ...(options?.startupTrace ? { startupTrace: options.startupTrace } : {}),
    ...(options?.deferStartupAccountStartsUntil
      ? { deferStartupAccountStartsUntil: options.deferStartupAccountStartsUntil }
      : {}),
  });
  createdManagers.push({ channelIds, manager });
  return manager;
}

describe("server-channels auto restart", () => {
  const stableChannelRunMs = 5 * 60_000;
  let previousRegistry: PluginRegistry | null = null;

  beforeEach(() => {
    previousRegistry = getActivePluginRegistry();
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    hoisted.sleepWithAbort.mockClear();
    hoisted.startChannelApprovalHandlerBootstrap.mockReset();
    hoisted.startChannelApprovalHandlerBootstrap.mockResolvedValue(async () => {});
    setActiveDegradedSecretOwners([]);
  });

  afterEach(async () => {
    const stops = createdManagers
      .splice(0)
      .flatMap(({ channelIds, manager }) =>
        channelIds.map((channelId) => manager.stopChannel(channelId).catch(() => {})),
      );
    await vi.advanceTimersByTimeAsync(6_000);
    await Promise.allSettled(stops);
    await flushMicrotasks();
    vi.clearAllTimers();
    vi.useRealTimers();
    setActiveDegradedSecretOwners([]);
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
    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 11,
      "expected crash-loop restarts to reach the maximum attempt cap",
      { stepMs: 10, maxMs: 500 },
    );

    expect(startAccount).toHaveBeenCalledTimes(11);
    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(false);
    expect(account?.reconnectAttempts).toBe(11);
    expect(account?.lastError).toBe("channel exited without an error");

    await vi.advanceTimersByTimeAsync(200);
    expect(startAccount).toHaveBeenCalledTimes(11);
  });

  it("aborts the crashed task's signal before starting its replacement", async () => {
    const signals: AbortSignal[] = [];
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      signals.push(ctx.abortSignal);
      throw new Error("crash");
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 2,
      "expected a crash-loop restart",
      { stepMs: 10, maxMs: 500 },
    );

    // A crashed startAccount can leave background work racing on its signal
    // (e.g. a reconnect loop). The replacement must never overlap that lifetime.
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it.each(["resolve", "reject"] as const)(
    "resets the restart counter after a stable run that ends with %s",
    async (outcome) => {
      const attemptsAtStart: number[] = [];
      let calls = 0;
      const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
        attemptsAtStart.push(ctx.getStatus().reconnectAttempts ?? 0);
        calls += 1;
        if (calls === 3) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, stableChannelRunMs + 1_000);
          });
          if (outcome === "reject") {
            throw new Error("stable run ended");
          }
        }
      });
      installTestRegistry(createTestPlugin({ startAccount }));
      const manager = createManager();

      await manager.startChannels();
      // Two instant exits accumulate attempts 1 and 2; the third run is stable.
      await advanceTimersUntil(
        () => startAccount.mock.calls.length >= 3,
        "expected two crash-loop restarts before the stable run",
        { stepMs: 10, maxMs: 500 },
      );
      await advanceTimersUntil(
        () => startAccount.mock.calls.length >= 4,
        "expected an auto-restart after the stable run exited",
        { stepMs: 30_000, maxMs: 4 * stableChannelRunMs },
      );

      expect(attemptsAtStart[3]).toBe(1);
    },
  );

  it("does not count slow cleanup as a stable channel run", async () => {
    const attemptsAtStart: number[] = [];
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      attemptsAtStart.push(ctx.getStatus().reconnectAttempts ?? 0);
    });
    hoisted.startChannelApprovalHandlerBootstrap.mockImplementation(async () => {
      const run = hoisted.startChannelApprovalHandlerBootstrap.mock.calls.length;
      return async () => {
        if (run === 3) {
          await new Promise<void>((resolve) => {
            setTimeout(resolve, stableChannelRunMs + 1_000);
          });
        }
      };
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 3,
      "expected two crash-loop restarts before slow cleanup",
      { stepMs: 10, maxMs: 500 },
    );
    await advanceTimersUntil(
      () => startAccount.mock.calls.length >= 4,
      "expected an auto-restart after slow cleanup",
      { stepMs: 30_000, maxMs: 4 * stableChannelRunMs },
    );

    expect(attemptsAtStart[3]).toBe(3);
  });

  it("records a clean channel monitor exit before auto-restart", async () => {
    const startAccount = vi.fn(async () => {});
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await flushMicrotasks();

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

  it("lets stop hooks update status after aborting the running task", async () => {
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.setStatus({
        accountId: DEFAULT_ACCOUNT_ID,
        running: true,
        connected: true,
        lastError: "startup warning",
      });
      await new Promise<void>((resolve) => {
        ctx.abortSignal.addEventListener("abort", () => resolve(), { once: true });
      });
    });
    const stopAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.setStatus({
        accountId: DEFAULT_ACCOUNT_ID,
        connected: false,
        lastError: null,
      });
    });
    installTestRegistry(createTestPlugin({ startAccount, stopAccount }));
    const manager = createManager();

    await manager.startChannels();
    await flushMicrotasks();
    await manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);

    const snapshot = manager.getRuntimeSnapshot();
    const account = snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(stopAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.connected).toBe(false);
    expect(account?.lastError).toBeNull();
  });

  it("does not enumerate configured accounts when stopping a never-started channel", async () => {
    const listAccountIds = vi.fn(() => [DEFAULT_ACCOUNT_ID]);
    const resolveAccount = vi.fn(() => ({ enabled: true, configured: true }));
    const stopAccount = vi.fn(async () => undefined);
    installTestRegistry(createTestPlugin({ listAccountIds, resolveAccount, stopAccount }));
    const manager = createManager();

    await manager.stopChannel("discord");

    expect(listAccountIds).not.toHaveBeenCalled();
    expect(resolveAccount).not.toHaveBeenCalled();
    expect(stopAccount).not.toHaveBeenCalled();
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

  it("does not auto-restart a channel task exit marked as terminal disconnect", async () => {
    const startAccount = vi.fn(
      async ({
        setStatus,
        accountId,
      }: {
        setStatus: ChannelGatewayContext["setStatus"];
        accountId: string;
      }) => {
        setStatus({ accountId, terminalDisconnect: true });
      },
    );
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    await vi.advanceTimersByTimeAsync(200);

    expect(startAccount).toHaveBeenCalledTimes(1);
    const snapshot = manager.getRuntimeSnapshot();
    expect(snapshot.channelAccounts.discord?.[DEFAULT_ACCOUNT_ID]?.terminalDisconnect).toBe(true);
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
    await waitForMicrotaskCondition(
      () => startAccount.mock.calls.length === 2,
      "expected timed-out recovery stop to restart without backoff",
    );

    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("does not restart when a timed-out recovery stop settles as terminal", async () => {
    const releaseFirstTask = createDeferred();
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.abortSignal.addEventListener("abort", () => {}, { once: true });
      await releaseFirstTask.promise;
      ctx.setStatus({ accountId: DEFAULT_ACCOUNT_ID, terminalDisconnect: true });
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, { manual: false });
    await vi.advanceTimersByTimeAsync(5_000);
    await stopTask;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    releaseFirstTask.resolve();
    await waitForMicrotaskCondition(
      () =>
        manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID]
          ?.restartPending === false,
      "expected terminal recovery completion to clear restart state",
    );

    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.terminalDisconnect).toBe(true);
    expect(account?.restartPending).toBe(false);
    expect(account?.reconnectAttempts).toBe(0);
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("keeps recovery timeout diagnostics when a stale task reports connected after abort", async () => {
    let emitLateStatus: (() => void) | undefined;
    const startAccount = vi.fn(async (ctx: ChannelGatewayContext<TestAccount>) => {
      ctx.setStatus({
        accountId: DEFAULT_ACCOUNT_ID,
        connected: true,
        lastError: null,
      });
      await new Promise<void>(() => {
        ctx.abortSignal.addEventListener(
          "abort",
          () => {
            emitLateStatus = () =>
              ctx.setStatus({
                accountId: DEFAULT_ACCOUNT_ID,
                connected: true,
                lastError: null,
              });
          },
          { once: true },
        );
      });
    });
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    await manager.startChannels();
    const recoveryStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
      manual: false,
    });
    await vi.advanceTimersByTimeAsync(5_000);
    await recoveryStopTask;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    emitLateStatus?.();
    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.connected).toBe(false);
    expect(account?.restartPending).toBe(true);
    expect(account?.reconnectAttempts).toBe(0);
    expect(account?.lastError).toContain("channel stop timed out");
  });

  it("resumes startup on the second recovery pass while the stale task is still pending", async () => {
    const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      abortSignal.addEventListener("abort", () => {}, { once: true });
      await new Promise<void>(() => {});
    });
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

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    let account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.restartPending).toBe(true);

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);

    account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(account?.running).toBe(true);
    expect(account?.restartPending).toBe(false);
    expect(account?.reconnectAttempts).toBe(0);
    expect(account?.lastError).toBeNull();
  });

  it("keeps the second recovery task running when the stale task rejects", async () => {
    const releaseFirstTask = createDeferred();
    let startCount = 0;
    const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      startCount += 1;
      abortSignal.addEventListener("abort", () => {}, { once: true });
      if (startCount === 1) {
        await releaseFirstTask.promise;
        throw new Error("late stale worker exit");
      }
      await new Promise<void>(() => {});
    });
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

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    expect(startAccount).toHaveBeenCalledTimes(2);

    releaseFirstTask.resolve();
    await flushMicrotasks();

    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(account?.running).toBe(true);
    expect(account?.restartPending).toBe(false);
    expect(account?.lastError).toBeNull();
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("restarts immediately when recovery stop timeout settles with an error", async () => {
    const rejectFirstTask = createDeferred();
    let startCount = 0;
    const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      startCount += 1;
      abortSignal.addEventListener("abort", () => {}, { once: true });
      if (startCount === 1) {
        await rejectFirstTask.promise;
        throw new Error("late worker exit");
      }
      await new Promise<void>(() => {});
    });
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

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    rejectFirstTask.resolve();
    await waitForMicrotaskCondition(
      () => startAccount.mock.calls.length === 2,
      "expected rejected timed-out recovery stop to restart without backoff",
    );

    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(account?.running).toBe(true);
    expect(account?.restartPending).toBe(false);
    expect(account?.lastError).toBeNull();
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("waits for an explicit start after recovery stop timeout", async () => {
    const releaseFirstTask = createDeferred();
    let startCount = 0;
    const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      startCount += 1;
      abortSignal.addEventListener("abort", () => {}, { once: true });
      if (startCount === 1) {
        await releaseFirstTask.promise;
        return;
      }
      await new Promise<void>(() => {});
    });
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
    await waitForMicrotaskCondition(() => {
      const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
      return account?.running === false && account.restartPending === false;
    }, "expected timed-out recovery stop to settle without restarting");

    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.restartPending).toBe(false);
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await waitForMicrotaskCondition(
      () => startAccount.mock.calls.length === 2,
      "expected explicit post-timeout start to restart the channel",
    );

    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
  });

  it("consumes startup failures during immediate recovery restart", async () => {
    const unhandledRejection = vi.fn();
    process.on("unhandledRejection", unhandledRejection);
    try {
      const releaseFirstTask = createDeferred();
      let isConfiguredCalls = 0;
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
          isConfigured: () => {
            isConfiguredCalls += 1;
            if (isConfiguredCalls > 1) {
              throw new Error("restart config missing");
            }
            return true;
          },
        }),
      );
      const manager = createManager();

      await manager.startChannels();
      const recoveryStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID, {
        manual: false,
      });
      await vi.advanceTimersByTimeAsync(5_000);
      await recoveryStopTask;

      await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
      releaseFirstTask.resolve();
      await waitForMicrotaskCondition(
        () =>
          manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID]?.lastError ===
          "restart config missing",
        "expected immediate recovery restart failure to be recorded",
      );
      await flushMicrotasks();

      const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
      expect(startAccount).toHaveBeenCalledTimes(1);
      expect(account?.running).toBe(false);
      expect(account?.restartPending).toBe(false);
      expect(unhandledRejection).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandledRejection);
    }
  });

  it("lets manual stops cancel recovery restart after recovery stop times out", async () => {
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

    const manualStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await vi.advanceTimersByTimeAsync(5_000);
    await manualStopTask;
    releaseFirstTask.resolve();
    await vi.advanceTimersByTimeAsync(10);
    await flushMicrotasks();

    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(account?.running).toBe(false);
    expect(account?.restartPending).toBe(false);
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(true);
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await waitForMicrotaskCondition(
      () => hoisted.sleepWithAbort.mock.calls.length === 1,
      "expected later ordinary exit to use restart backoff",
    );

    expect(startAccount).toHaveBeenCalledTimes(2);
    expect(hoisted.sleepWithAbort.mock.calls[0]?.[0]).toBe(10);
  });

  it("lets explicit starts win after a manual timeout during recovery stop", async () => {
    const releaseFirstTask = createDeferred();
    let startCount = 0;
    const startAccount = vi.fn(async ({ abortSignal }: { abortSignal: AbortSignal }) => {
      startCount += 1;
      abortSignal.addEventListener("abort", () => {}, { once: true });
      if (startCount === 1) {
        await releaseFirstTask.promise;
        return;
      }
      await new Promise<void>(() => {});
    });
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

    const manualStopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await vi.advanceTimersByTimeAsync(5_000);
    await manualStopTask;
    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    releaseFirstTask.resolve();
    await waitForMicrotaskCondition(
      () => startAccount.mock.calls.length === 2,
      "expected explicit start to clear manual stop and restart after old task exits",
    );

    const account = manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID];
    expect(account?.running).toBe(true);
    expect(account?.restartPending).toBe(false);
    expect(manager.isManuallyStopped("discord", DEFAULT_ACCOUNT_ID)).toBe(false);
    expect(hoisted.sleepWithAbort).not.toHaveBeenCalled();
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

  it("suppresses automatic channel starts while allowing manual starts", async () => {
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});
    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager();

    manager.setAutostartSuppression({
      reason: "crash-loop-breaker",
      message: "safe mode",
    });

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID);
    await flushMicrotasks();
    expect(startAccount).not.toHaveBeenCalled();
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.default?.lastError).toBe(
      "safe mode",
    );

    await manager.startChannel("discord", DEFAULT_ACCOUNT_ID, { manual: true });
    await flushMicrotasks();

    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(manager.getAutostartSuppression()?.reason).toBe("crash-loop-breaker");
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

  it("passes the full runtime path to bundled channel startup", async () => {
    const fullRuntime = {
      ...createRuntimeChannel(),
      marker: "full-channel-runtime",
    } as PluginRuntime["channel"] & { marker: string };
    const resolveChannelRuntime = vi.fn(() => fullRuntime);
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});

    installTestRegistry({
      plugin: createTestPlugin({ startAccount }),
      origin: "bundled",
    });
    const manager = createManager({ resolveChannelRuntime });

    await manager.startChannels();

    expect(resolveChannelRuntime).toHaveBeenCalledTimes(1);
    expect(startAccount).toHaveBeenCalledTimes(1);
    const ctx = firstStartAccountContext(startAccount);
    expect((ctx?.channelRuntime as { marker?: string } | undefined)?.marker).toBe(
      "full-channel-runtime",
    );
    expect(typeof (ctx?.channelRuntime as PluginRuntime["channel"] | undefined)?.inbound.run).toBe(
      "function",
    );
  });

  it("keeps the full runtime path for non-bundled channels", async () => {
    const fullRuntime = {
      ...createRuntimeChannel(),
      marker: "full-channel-runtime",
    } as PluginRuntime["channel"] & { marker: string };
    const resolveChannelRuntime = vi.fn(() => fullRuntime);
    const startAccount = vi.fn(async (_ctx: ChannelGatewayContext<TestAccount>) => {});

    installTestRegistry({ plugin: createTestPlugin({ startAccount }), origin: "workspace" });
    const manager = createManager({ resolveChannelRuntime });

    await manager.startChannels();

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
    const startAccount = vi.fn(
      async ({ channelRuntime: channelRuntimeLocal }: ChannelGatewayContext<TestAccount>) => {
        channelRuntimeLocal?.runtimeContexts.register({
          channelId: "discord",
          accountId: DEFAULT_ACCOUNT_ID,
          capability: "approval.native",
          context: { token: "tracked" },
        });
      },
    );

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

  it("keeps only the degraded channel account cold", async () => {
    const discordStart = vi.fn(async (_context: ChannelGatewayContext<TestAccount>) => {});
    const slackStart = vi.fn(async () => {});
    const discordResolve = vi.fn(() => ({ enabled: true, configured: true }));
    installTestRegistry(
      createTestPlugin({
        id: "discord",
        order: 1,
        listAccountIds: () => ["broken", "healthy"],
        resolveAccount: discordResolve,
        startAccount: discordStart,
      }),
      createTestPlugin({ id: "slack", order: 2, startAccount: slackStart }),
    );
    setActiveDegradedSecretOwners([
      {
        ownerKind: "account",
        ownerId: "discord:broken",
        state: "unavailable",
        paths: ["channels.discord.accounts.broken.token"],
        refKeys: ["env:default:BROKEN_TOKEN"],
        reason: "secret reference was not found",
      },
    ]);
    const manager = createManager({ channelIds: ["discord", "slack"] });

    await expect(manager.startChannels()).resolves.toBeUndefined();

    expect(discordStart.mock.calls.map(([context]) => context.accountId)).toEqual(["healthy"]);
    expect(discordResolve).toHaveBeenCalledOnce();
    expect(discordResolve).toHaveBeenCalledWith(expect.anything(), "healthy");
    expect(slackStart).toHaveBeenCalledTimes(1);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.broken).toMatchObject({
      running: false,
      lastError:
        "Secret owner account:discord:broken is configured but unavailable (secret reference was not found).",
    });
  });

  it("keeps one file-credential account cold and recovers it without restarting siblings", async () => {
    let broken = true;
    const startAccount = vi.fn(
      async ({ abortSignal }: ChannelGatewayContext<TestAccount>) =>
        await new Promise<void>((resolve) => {
          abortSignal.addEventListener("abort", () => resolve(), { once: true });
        }),
    );
    installTestRegistry(
      createTestPlugin({
        id: "discord",
        listAccountIds: () => ["broken", "healthy"],
        resolveAccount: (_cfg, accountId) => ({
          enabled: true,
          configured: true,
          ...(accountId === "broken" && broken
            ? {
                credentialDiagnostics: [
                  {
                    code: "CREDENTIAL_FILE_UNAVAILABLE" as const,
                    path: "channels.discord.accounts.broken.tokenFile",
                    reason: "not-found",
                  },
                ],
              }
            : {}),
        }),
        startAccount,
      }),
    );
    const manager = createManager({ channelIds: ["discord"] });

    await expect(manager.startChannels()).resolves.toBeUndefined();

    expect(startAccount.mock.calls.map(([context]) => context.accountId)).toEqual(["healthy"]);
    expect(manager.getRuntimeSnapshot().channelAccounts.discord?.broken).toMatchObject({
      configured: true,
      running: false,
      lastError:
        "Secret owner account:discord:broken is configured but unavailable (credential file is unavailable).",
    });
    expect(listActiveDegradedSecretOwners()).toContainEqual(
      expect.objectContaining({
        ownerId: "discord:broken",
        paths: ["channels.discord.accounts.broken.tokenFile"],
        refKeys: [],
      }),
    );

    broken = false;
    await manager.startChannel("discord", "broken");

    expect(startAccount.mock.calls.map(([context]) => context.accountId)).toEqual([
      "healthy",
      "broken",
    ]);
    expect(listActiveDegradedSecretOwners()).not.toContainEqual(
      expect.objectContaining({ ownerId: "discord:broken" }),
    );
    await manager.stopChannel("discord");
  });

  it("uses fallback logger and runtime when a channel is missing startup wiring", async () => {
    const startAccount = vi.fn(async () => {
      throw new Error("invalid_auth");
    });
    installTestRegistry(createTestPlugin({ id: "slack", startAccount }));
    const manager = createManager({ channelIds: ["slack"], fillChannelDependencies: false });

    await manager.startChannels();
    await flushMicrotasks();

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
    expect(startAccount).not.toHaveBeenCalled();

    await waitForImmediate();
    await flushMicrotasks();

    const names = measureMock.mock.calls.map(([name]) => name);
    expect(names).toContain("channels.discord.start");
    expect(names).toContain("channels.discord.list-accounts");
    expect(names).toContain("channels.discord.runtime");
    expect(names).toContain("channels.discord.approval-bootstrap");
    expect(names).toContain("channels.discord.start-account-handoff");
    expect(startAccount).toHaveBeenCalledTimes(1);
  });

  it("ends startup trace spans before long-lived channel account tasks settle", async () => {
    const activeNames = new Set<string>();
    const measuredNames: string[] = [];
    const startupTrace = {
      measure: async <T>(name: string, run: () => T | Promise<T>) => {
        activeNames.add(name);
        measuredNames.push(name);
        try {
          return await run();
        } finally {
          activeNames.delete(name);
        }
      },
    };
    const channelTask = createDeferred();
    const startAccount = vi.fn(() => channelTask.promise);

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({ startupTrace });

    await manager.startChannels();
    await waitForImmediate();
    await flushMicrotasks();

    expect(startAccount).toHaveBeenCalledTimes(1);
    expect(measuredNames).toContain("channels.discord.start-account-handoff");
    expect(activeNames.has("channels.discord.start-account-handoff")).toBe(false);
    expect(
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID]?.running,
    ).toBe(true);

    channelTask.resolve();
    await flushMicrotasks();
  });

  it("does not start deferred channel accounts after stop wins the startup handoff", async () => {
    const releaseAccountStart = createDeferred();
    const measureMock = vi.fn(async (name: string, run: () => unknown) => await run());
    const startupTrace = {
      measure: async <T>(name: string, run: () => T | Promise<T>) =>
        (await measureMock(name, run)) as T,
    };
    const startAccount = vi.fn(async () => {});

    installTestRegistry(createTestPlugin({ startAccount }));
    const manager = createManager({
      startupTrace,
      deferStartupAccountStartsUntil: releaseAccountStart.promise,
    });

    await manager.startChannels();
    await flushMicrotasks();
    const stopTask = manager.stopChannel("discord", DEFAULT_ACCOUNT_ID);
    await flushMicrotasks();
    await stopTask;
    await flushMicrotasks();
    releaseAccountStart.resolve();
    await flushMicrotasks();

    expect(startAccount).not.toHaveBeenCalled();
    expect(measureMock.mock.calls.map(([name]) => name)).not.toContain(
      "channels.discord.start-account-handoff",
    );
    expect(
      manager.getRuntimeSnapshot().channelAccounts.discord?.[DEFAULT_ACCOUNT_ID]?.running,
    ).not.toBe(true);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

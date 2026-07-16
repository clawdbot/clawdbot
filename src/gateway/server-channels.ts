// Gateway channel manager.
// Starts, stops, restarts, and snapshots plugin channel account runtimes.
import { RetrySupervisor } from "../../packages/retry/src/index.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { type ChannelId, getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startChannelApprovalHandlerBootstrap } from "../infra/approval-handler-bootstrap.js";
import { type BackoffPolicy, sleepWithAbort } from "../infra/backoff.js";
import { createTaskScopedChannelRuntime } from "../infra/channel-runtime-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  createSubsystemLogger,
  runtimeForLogger,
  type SubsystemLogger,
} from "../logging/subsystem.js";
import { withPluginHttpRouteRegistry } from "../plugins/http-registry.js";
import type { PluginRegistry } from "../plugins/registry.js";
import type { PluginRuntimeChannel } from "../plugins/runtime/types-channel.js";
import { resolveAccountEntry, resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { isAccountEnabled } from "../shared/account-enabled.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import type {
  ChannelRuntimeSnapshot,
  StartChannelOptions,
} from "./server-channel-runtime.types.js";

const RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
};
const MAX_RESTARTS = 10;
const CHANNEL_STABLE_RUN_MS = RESTART_POLICY.maxMs;
const CHANNEL_STOP_ABORT_TIMEOUT_MS = 5_000;
const CHANNEL_STARTUP_CONCURRENCY = 4;
function waitForChannelStartupHandoff(): Promise<void> {
  return new Promise((resolve) => {
    const handle = setImmediate(resolve);
    handle.unref?.();
  });
}

type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;
  starting: Map<string, Promise<void>>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
};

function sanitizeAbortedTaskStatusPatch(
  patch: ChannelAccountSnapshot,
  current: ChannelAccountSnapshot,
): ChannelAccountSnapshot {
  const next = { ...patch };
  delete next.running;
  delete next.restartPending;
  delete next.reconnectAttempts;
  delete next.lastStartAt;
  delete next.lastStopAt;

  // A stale task may still emit a late "connected" heartbeat after the gateway
  // has already aborted it and marked restart recovery pending. Do not let that
  // old task make the stopped runtime look connected again.
  if (next.connected === true) {
    delete next.connected;
    delete next.lastConnectedAt;
    delete next.lastEventAt;
    delete next.lastTransportActivityAt;
  }

  // Preserve actionable lifecycle diagnostics (for example a stop-timeout
  // recovery error) against late stale-task status patches that merely clear
  // plugin transport errors.
  if (next.lastError === null && current.lastError) {
    delete next.lastError;
  }

  return next;
}

type HealthMonitorConfig = {
  healthMonitor?: {
    enabled?: boolean;
  };
};

type ChannelHealthMonitorConfig = HealthMonitorConfig & {
  accounts?: Record<string, HealthMonitorConfig>;
};

export type ChannelAutostartSuppression = {
  reason: "crash-loop-breaker";
  message: string;
};

type GatewayStartupTrace = {
  measure: <T>(name: string, run: () => T | Promise<T>) => Promise<T>;
};

function createRuntimeStore(): ChannelRuntimeStore {
  return {
    aborts: new Map(),
    starting: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
  };
}

function resolveDefaultRuntime(channelId: ChannelId): ChannelAccountSnapshot {
  const plugin = getChannelPlugin(channelId);
  return plugin?.status?.defaultRuntime ?? { accountId: DEFAULT_ACCOUNT_ID };
}

function cloneDefaultRuntime(channelId: ChannelId, accountId: string): ChannelAccountSnapshot {
  return { ...resolveDefaultRuntime(channelId), accountId };
}

async function waitForChannelStopGracefully(task: Promise<unknown> | undefined, timeoutMs: number) {
  if (!task) {
    return true;
  }
  // Channel stop hooks can hang during provider disconnects. Bound the wait so
  // restart/reload can continue after aborting the runtime.
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolve(false);
      }
    }, timeoutMs);
    timer.unref?.();
    const resolveSettled = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(true);
    };
    void task.then(resolveSettled, resolveSettled);
  });
}

function applyDescribedAccountFields(
  next: ChannelAccountSnapshot,
  described: ChannelAccountSnapshot | undefined,
) {
  if (!described) {
    next.configured ??= true;
    return next;
  }
  if (typeof described.configured === "boolean") {
    next.configured = described.configured;
  } else {
    next.configured ??= true;
  }
  if (described.mode !== undefined) {
    next.mode = described.mode;
  }
  return next;
}

type ChannelManagerOptions = {
  getRuntimeConfig: () => OpenClawConfig;
  channelLogs: Partial<Record<ChannelId, SubsystemLogger>>;
  channelRuntimeEnvs: Partial<Record<ChannelId, RuntimeEnv>>;
  /**
   * Optional channel runtime helpers for channel plugins.
   *
   * When provided, this value is passed to all channel plugins via the
   * `channelRuntime` field in `ChannelGatewayContext`, enabling external
   * plugins to access Plugin SDK channel features (AI dispatch, routing,
   * session management, startup runtime contexts, text processing, etc.).
   *
   * This field is optional - omitting it maintains backward compatibility
   * with existing channels. When provided, it must be a real
   * `createPluginRuntime().channel` surface; partial stubs are not supported.
   *
   * @example
   * ```typescript
   * import { createPluginRuntime } from "../plugins/runtime/index.js";
   *
   * const channelManager = createChannelManager({
   *   getRuntimeConfig,
   *   channelLogs,
   *   channelRuntimeEnvs,
   *   channelRuntime: createPluginRuntime().channel,
   * });
   * ```
   *
   * @since Plugin SDK 2026.2.19
   * @see {@link ChannelGatewayContext.channelRuntime}
   */
  channelRuntime?: PluginRuntimeChannel;
  /**
   * Lazily resolves optional channel runtime helpers for channel plugins.
   *
   * Use this when the caller wants to avoid instantiating the full plugin channel
   * runtime during gateway startup. The manager only needs the runtime surface once
   * a channel account actually starts. The resolved value must be a real
   * `createPluginRuntime().channel` surface.
   */
  resolveChannelRuntime?: () => PluginRuntimeChannel | Promise<PluginRuntimeChannel>;
  getPluginHttpRouteRegistry?: () => PluginRegistry;
  startupTrace?: GatewayStartupTrace;
  deferStartupAccountStartsUntil?: Promise<void>;
};

type StopChannelOptions = {
  manual?: boolean;
};

async function waitForDeferredAccountStart(
  deferred: Promise<void>,
  abortSignal: AbortSignal,
): Promise<void> {
  if (abortSignal.aborted) {
    return;
  }
  await Promise.race([
    deferred,
    new Promise<void>((resolve) => {
      abortSignal.addEventListener("abort", () => resolve(), { once: true });
    }),
  ]);
}

export type ChannelManager = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannels: () => Promise<void>;
  startChannel: (
    channel: ChannelId,
    accountId?: string,
    opts?: StartChannelOptions,
  ) => Promise<void>;
  stopChannel: (channel: ChannelId, accountId?: string, opts?: StopChannelOptions) => Promise<void>;
  setAutostartSuppression: (suppression: ChannelAutostartSuppression | null) => void;
  getAutostartSuppression: () => ChannelAutostartSuppression | null;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
  isHealthMonitorEnabled: (channelId: ChannelId, accountId: string) => boolean;
};

// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager {
  const {
    getRuntimeConfig,
    channelLogs,
    channelRuntimeEnvs,
    channelRuntime,
    resolveChannelRuntime,
    getPluginHttpRouteRegistry,
    startupTrace,
  } = opts;

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();
  const restarts = new Map<string, RetrySupervisor>();
  // Tracks accounts that were manually stopped so we don't auto-restart them.
  const manuallyStopped = new Set<string>();
  const recoveryStopTimedOut = new Set<string>();
  const recoveryStartRequested = new Set<string>();
  let autostartSuppression: ChannelAutostartSuppression | null = null;

  const restartKey = (channelId: ChannelId, accountId: string) => `${channelId}:${accountId}`;
  const ensureChannelLog = (channelId: ChannelId): SubsystemLogger => {
    channelLogs[channelId] ??= createSubsystemLogger("channels").child(channelId);
    return channelLogs[channelId];
  };
  const ensureChannelRuntime = (channelId: ChannelId): RuntimeEnv => {
    channelRuntimeEnvs[channelId] ??= runtimeForLogger(ensureChannelLog(channelId));
    return channelRuntimeEnvs[channelId];
  };

  const resolveAccountHealthMonitorOverride = (
    channelConfig: ChannelHealthMonitorConfig | undefined,
    accountId: string,
  ): boolean | undefined => {
    if (!channelConfig?.accounts) {
      return undefined;
    }
    const direct = resolveAccountEntry(channelConfig.accounts, accountId);
    if (typeof direct?.healthMonitor?.enabled === "boolean") {
      return direct.healthMonitor.enabled;
    }

    const normalizedAccountId = normalizeOptionalAccountId(accountId);
    if (!normalizedAccountId) {
      return undefined;
    }
    const match = resolveNormalizedAccountEntry(
      channelConfig.accounts,
      normalizedAccountId,
      normalizeAccountId,
    );
    if (typeof match?.healthMonitor?.enabled !== "boolean") {
      return undefined;
    }
    return match.healthMonitor.enabled;
  };

  const isHealthMonitorEnabled = (channelId: ChannelId, accountId: string): boolean => {
    const cfg = getRuntimeConfig();
    const channelConfig = cfg.channels?.[channelId] as ChannelHealthMonitorConfig | undefined;
    const accountOverride = resolveAccountHealthMonitorOverride(channelConfig, accountId);
    const channelOverride = channelConfig?.healthMonitor?.enabled;

    if (typeof accountOverride === "boolean") {
      return accountOverride;
    }

    if (typeof channelOverride === "boolean") {
      return channelOverride;
    }

    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return true;
    }
    try {
      // Probe only: health-monitor config is read directly from raw channel config above.
      // This call exists solely to fail closed if resolver-side config loading is broken.
      plugin.config.resolveAccount(cfg, accountId);
    } catch (err) {
      ensureChannelLog(channelId).warn?.(
        `[${channelId}:${accountId}] health-monitor: failed to resolve account; skipping monitor (${formatErrorMessage(err)})`,
      );
      return false;
    }

    return true;
  };

  const getStore = (channelId: ChannelId): ChannelRuntimeStore => {
    const existing = channelStores.get(channelId);
    if (existing) {
      return existing;
    }
    const next = createRuntimeStore();
    channelStores.set(channelId, next);
    return next;
  };

  const getRuntime = (channelId: ChannelId, accountId: string): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    return store.runtimes.get(accountId) ?? cloneDefaultRuntime(channelId, accountId);
  };

  const setRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
  ): ChannelAccountSnapshot => {
    const store = getStore(channelId);
    const current = getRuntime(channelId, accountId);
    const next = { ...current, ...patch, accountId };
    store.runtimes.set(accountId, next);
    return next;
  };

  const setRuntimeFromTaskStatus = (
    channelId: ChannelId,
    accountId: string,
    patch: ChannelAccountSnapshot,
    abortSignal?: AbortSignal,
  ): ChannelAccountSnapshot => {
    const safePatch = abortSignal?.aborted
      ? sanitizeAbortedTaskStatusPatch(patch, getRuntime(channelId, accountId))
      : patch;
    return setRuntime(channelId, accountId, safePatch);
  };

  const setStoppedRuntime = (
    channelId: ChannelId,
    accountId: string,
    patch: Omit<ChannelAccountSnapshot, "accountId" | "running"> = {},
  ): ChannelAccountSnapshot => {
    const current = getRuntime(channelId, accountId);
    return setRuntime(channelId, accountId, {
      accountId,
      running: false,
      ...(typeof current.connected === "boolean" ? { connected: false } : {}),
      ...patch,
    });
  };

  const getChannelRuntime = async (): Promise<PluginRuntimeChannel | undefined> => {
    if (channelRuntime) {
      return channelRuntime;
    }
    return await resolveChannelRuntime?.();
  };
  const measureStartup = async <T>(name: string, run: () => T | Promise<T>): Promise<T> => {
    return startupTrace ? startupTrace.measure(name, run) : await run();
  };

  const evictStaleChannelAccountState = (
    channelId: ChannelId,
    store: ChannelRuntimeStore,
    accountIds: readonly string[],
  ) => {
    const activeAccountIds = new Set(accountIds);
    for (const id of store.runtimes.keys()) {
      if (
        activeAccountIds.has(id) ||
        store.aborts.has(id) ||
        store.starting.has(id) ||
        store.tasks.has(id)
      ) {
        continue;
      }
      store.runtimes.delete(id);
      restarts.delete(restartKey(channelId, id));
      manuallyStopped.delete(restartKey(channelId, id));
      recoveryStartRequested.delete(restartKey(channelId, id));
    }
  };

  const startChannelInternal = async (
    channelId: ChannelId,
    accountId?: string,
    optsValue: StartChannelOptions = {},
  ) => {
    const plugin = getChannelPlugin(channelId);
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      return;
    }
    const { preserveRestartAttempts = false, preserveManualStop = false } = optsValue;
    const cfg = getRuntimeConfig();
    resetDirectoryCache({ channel: channelId, accountId });
    const store = getStore(channelId);
    const accountIds = accountId
      ? [accountId]
      : await measureStartup(`channels.${channelId}.list-accounts`, () =>
          plugin.config.listAccountIds(cfg),
        );
    if (!accountId) {
      evictStaleChannelAccountState(channelId, store, accountIds);
    }
    if (accountIds.length === 0) {
      return;
    }
    if (autostartSuppression && optsValue.manual !== true) {
      // Safe mode must block every automatic channel start surface; otherwise
      // config reloads can undo the crash-loop breaker while operators inspect.
      const suffix = accountId ? ` account ${accountId}` : "";
      ensureChannelLog(channelId).warn?.(
        `channel autostart suppressed by crash-loop breaker; refusing automatic start for ${channelId}${suffix}. Use channels.start to override.`,
      );
      for (const id of accountIds) {
        setStoppedRuntime(channelId, id, {
          restartPending: false,
          lastError: autostartSuppression.message,
        });
      }
      return;
    }

    const startup = await runTasksWithConcurrency({
      limit: CHANNEL_STARTUP_CONCURRENCY,
      tasks: accountIds.map((id) => async () => {
        const rKey = restartKey(channelId, id);
        if (store.tasks.has(id)) {
          let clearedTimedOutRecoveryTask = false;
          if (recoveryStopTimedOut.has(rKey)) {
            if (!preserveManualStop) {
              manuallyStopped.delete(rKey);
            }
            if (manuallyStopped.has(rKey)) {
              return;
            }
            // When a previous stop timed out and the health monitor is
            // requesting recovery again, clean up the stuck task so the
            // channel can actually restart instead of staying in limbo.
            if (recoveryStartRequested.has(rKey)) {
              recoveryStopTimedOut.delete(rKey);
              recoveryStartRequested.delete(rKey);
              restarts.delete(rKey);
              store.aborts.delete(id);
              store.tasks.delete(id);
              clearedTimedOutRecoveryTask = true;
              setRuntime(channelId, id, {
                accountId: id,
                restartPending: false,
                reconnectAttempts: 0,
              });
            } else {
              recoveryStartRequested.add(rKey);
              setRuntime(channelId, id, { accountId: id, restartPending: true });
              return;
            }
          }
          if (!clearedTimedOutRecoveryTask) {
            return;
          }
        }
        const existingStart = store.starting.get(id);
        if (existingStart) {
          await existingStart;
          return;
        }

        let resolveStart: (() => void) | undefined;
        const startGate = new Promise<void>((resolve) => {
          resolveStart = resolve;
        });
        store.starting.set(id, startGate);

        // Reserve the account before the first await so overlapping start calls
        // cannot race into duplicate provider boots for the same account.
        const abort = new AbortController();
        store.aborts.set(id, abort);
        let handedOffTask = false;
        const log = ensureChannelLog(channelId);
        const runtime = ensureChannelRuntime(channelId);
        let scopedChannelRuntime: {
          channelRuntime?: PluginRuntimeChannel;
          dispose: () => void;
        } | null = null;
        let channelRuntimeForTask: PluginRuntimeChannel | undefined;
        let stopApprovalBootstrap: () => Promise<void> = async () => {};
        const stopTaskScopedApprovalRuntime = async () => {
          const scopedRuntime = scopedChannelRuntime;
          scopedChannelRuntime = null;
          const stopBootstrap = stopApprovalBootstrap;
          stopApprovalBootstrap = async () => {};
          scopedRuntime?.dispose();
          await stopBootstrap();
        };
        const cleanupTaskScopedApprovalRuntime = async (label: string) => {
          try {
            await stopTaskScopedApprovalRuntime();
          } catch (error) {
            log.error?.(`[${id}] ${label}: ${formatErrorMessage(error)}`);
          }
        };

        try {
          const account = plugin.config.resolveAccount(cfg, id);
          const enabled = plugin.config.isEnabled
            ? plugin.config.isEnabled(account, cfg)
            : isAccountEnabled(account);
          if (!enabled) {
            setRuntime(channelId, id, {
              accountId: id,
              enabled: false,
              configured: true,
              running: false,
              restartPending: false,
              lastError: plugin.config.disabledReason?.(account, cfg) ?? "disabled",
            });
            return;
          }

          let configured = true;
          if (plugin.config.isConfigured) {
            configured = await measureStartup(`channels.${channelId}.is-configured`, () =>
              plugin.config.isConfigured!(account, cfg),
            );
          }
          if (!configured) {
            setRuntime(channelId, id, {
              accountId: id,
              enabled: true,
              configured: false,
              running: false,
              restartPending: false,
              lastError: plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured",
            });
            return;
          }

          if (!preserveManualStop) {
            manuallyStopped.delete(rKey);
          }

          if (abort.signal.aborted || manuallyStopped.has(rKey)) {
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastStopAt: Date.now(),
            });
            return;
          }

          scopedChannelRuntime = await measureStartup(`channels.${channelId}.runtime`, async () =>
            createTaskScopedChannelRuntime({
              channelRuntime: await getChannelRuntime(),
            }),
          );
          channelRuntimeForTask = scopedChannelRuntime.channelRuntime;

          if (!preserveRestartAttempts) {
            restarts.delete(rKey);
          }
          try {
            stopApprovalBootstrap = await measureStartup(
              `channels.${channelId}.approval-bootstrap`,
              () =>
                startChannelApprovalHandlerBootstrap({
                  plugin,
                  cfg,
                  accountId: id,
                  channelRuntime: channelRuntimeForTask,
                  logger: log,
                }),
            );
          } catch (error) {
            log.error?.(`[${id}] native approval bootstrap failed: ${formatErrorMessage(error)}`);
          }
          let channelRunDurationMs: number | undefined;
          setRuntime(channelId, id, {
            accountId: id,
            enabled: true,
            configured: true,
            running: true,
            restartPending: false,
            lastStartAt: Date.now(),
            lastError: null,
            reconnectAttempts: preserveRestartAttempts ? (restarts.get(rKey)?.attempts ?? 0) : 0,
          });
          const task = Promise.resolve().then(async () => {
            if (optsValue.deferAccountStartUntil) {
              await waitForDeferredAccountStart(optsValue.deferAccountStartUntil, abort.signal);
            } else if (startupTrace) {
              await waitForChannelStartupHandoff();
            }
            if (abort.signal.aborted || manuallyStopped.has(rKey)) {
              return;
            }
            let startAccountTask: ReturnType<typeof startAccount> | undefined;
            await measureStartup(`channels.${channelId}.start-account-handoff`, () => {
              if (abort.signal.aborted || manuallyStopped.has(rKey)) {
                return;
              }
              const runStartAccount = () => {
                const startedAt = Date.now();
                const recordDuration = () => {
                  channelRunDurationMs = Date.now() - startedAt;
                };
                try {
                  return startAccount({
                    cfg,
                    accountId: id,
                    account,
                    runtime,
                    abortSignal: abort.signal,
                    log,
                    getStatus: () => getRuntime(channelId, id),
                    setStatus: (next) =>
                      isCurrentTask()
                        ? setRuntimeFromTaskStatus(channelId, id, next, abort.signal)
                        : getRuntime(channelId, id),
                    ...(channelRuntimeForTask ? { channelRuntime: channelRuntimeForTask } : {}),
                  }).finally(recordDuration);
                } catch (error) {
                  recordDuration();
                  throw error;
                }
              };
              const routeRegistry = getPluginHttpRouteRegistry?.();
              startAccountTask = routeRegistry
                ? withPluginHttpRouteRegistry(routeRegistry, runStartAccount)
                : runStartAccount();
            });
            if (!startAccountTask) {
              return;
            }
            await startAccountTask;
          });
          // Recovery can replace a timed-out task before the old promise settles.
          // Only the task that still owns the store slot may write lifecycle state.
          const trackedPromise = task
            .then(() => {
              if (abort.signal.aborted || manuallyStopped.has(rKey) || !isCurrentTask()) {
                return;
              }
              const message = "channel exited without an error";
              setRuntime(channelId, id, { accountId: id, lastError: message });
              log.error?.(`[${id}] ${message}`);
            })
            .catch((err: unknown) => {
              if (!isCurrentTask()) {
                return;
              }
              const message = formatErrorMessage(err);
              setRuntime(channelId, id, { accountId: id, lastError: message });
              log.error?.(`[${id}] channel exited: ${message}`);
            })
            .then(async () => {
              await cleanupTaskScopedApprovalRuntime("channel cleanup failed");
              if (!isCurrentTask()) {
                return;
              }
              setStoppedRuntime(channelId, id, {
                lastStopAt: Date.now(),
              });
            })
            .then(async () => {
              if (!isCurrentTask()) {
                return;
              }
              if (manuallyStopped.has(rKey)) {
                recoveryStopTimedOut.delete(rKey);
                recoveryStartRequested.delete(rKey);
                return;
              }
              if (getRuntime(channelId, id).terminalDisconnect) {
                // Authentication/session termination wins over pending recovery.
                // Leaving recovery state behind would restart a channel that needs user action.
                recoveryStopTimedOut.delete(rKey);
                recoveryStartRequested.delete(rKey);
                restarts.delete(rKey);
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: false,
                  reconnectAttempts: 0,
                });
                log.info?.(`[${id}] auto-restart skipped, terminal disconnect`);
                return;
              }
              if (recoveryStopTimedOut.has(rKey)) {
                recoveryStopTimedOut.delete(rKey);
                if (!recoveryStartRequested.delete(rKey)) {
                  setRuntime(channelId, id, {
                    accountId: id,
                    restartPending: false,
                    reconnectAttempts: 0,
                  });
                  if (store.tasks.get(id) === trackedPromise) {
                    store.tasks.delete(id);
                  }
                  if (store.aborts.get(id) === abort) {
                    store.aborts.delete(id);
                  }
                  return;
                }
                restarts.delete(rKey);
                log.info?.(`[${id}] restarting after timed-out channel stop completed`);
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: true,
                  reconnectAttempts: 0,
                });
                if (store.tasks.get(id) === trackedPromise) {
                  store.tasks.delete(id);
                }
                if (store.aborts.get(id) === abort) {
                  store.aborts.delete(id);
                }
                try {
                  await startChannelInternal(channelId, id, {
                    preserveManualStop: true,
                  });
                } catch {
                  // abort or startup failure — runtime state was recorded by startChannelInternal
                }
                return;
              }
              // Only plugin task lifetime counts. Deferred handoff and cleanup must not
              // make a short crash look stable and erase crash-loop attempts.
              if (
                channelRunDurationMs !== undefined &&
                channelRunDurationMs >= CHANNEL_STABLE_RUN_MS
              ) {
                restarts.delete(rKey);
              }
              const restart =
                restarts.get(rKey) ?? new RetrySupervisor(RESTART_POLICY, MAX_RESTARTS);
              restarts.set(rKey, restart);
              const retry = restart.next(abort.signal);
              if (!retry) {
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: false,
                  reconnectAttempts: restart.attempts,
                });
                log.error?.(`[${id}] giving up after ${MAX_RESTARTS} restart attempts`);
                return;
              }
              log.info?.(
                `[${id}] auto-restart attempt ${restart.attempts}/${MAX_RESTARTS} in ${Math.round(retry.delayMs / 1000)}s`,
              );
              setRuntime(channelId, id, {
                accountId: id,
                restartPending: true,
                reconnectAttempts: restart.attempts,
              });
              try {
                await sleepWithAbort(retry.delayMs, retry.signal);
                if (manuallyStopped.has(rKey)) {
                  return;
                }
                if (store.tasks.get(id) === trackedPromise) {
                  store.tasks.delete(id);
                }
                if (store.aborts.get(id) === abort) {
                  store.aborts.delete(id);
                }
                await startChannelInternal(channelId, id, {
                  preserveRestartAttempts: true,
                  preserveManualStop: true,
                });
              } catch {
                // abort or startup failure — next crash will retry
              }
            })
            .finally(() => {
              if (store.tasks.get(id) === trackedPromise) {
                store.tasks.delete(id);
              }
              if (store.aborts.get(id) === abort) {
                store.aborts.delete(id);
              }
            });
          function isCurrentTask() {
            return store.tasks.get(id) === trackedPromise;
          }
          handedOffTask = true;
          store.tasks.set(id, trackedPromise);
        } catch (error) {
          if (!handedOffTask) {
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastError: formatErrorMessage(error),
            });
          }
          throw error;
        } finally {
          resolveStart?.();
          if (store.starting.get(id) === startGate) {
            store.starting.delete(id);
          }
          if (!handedOffTask) {
            await cleanupTaskScopedApprovalRuntime("channel startup cleanup failed");
          }
          if (!handedOffTask && store.aborts.get(id) === abort) {
            store.aborts.delete(id);
          }
        }
      }),
    });
    if (startup.hasError) {
      throw startup.firstError;
    }
  };

  const startChannel = async (
    channelId: ChannelId,
    accountId?: string,
    optsValue: StartChannelOptions = {},
  ) => {
    await startChannelInternal(channelId, accountId, optsValue);
  };

  const stopChannel = async (
    channelId: ChannelId,
    accountId?: string,
    optsLocal: StopChannelOptions = {},
  ) => {
    const manual = optsLocal.manual ?? true;
    const plugin = getChannelPlugin(channelId);
    const store = getStore(channelId);
    const lifecycleIds = new Set<string>([
      ...store.aborts.keys(),
      ...store.starting.keys(),
      ...store.tasks.keys(),
    ]);
    if (!accountId && lifecycleIds.size === 0) {
      return;
    }
    // Fast path: nothing running and no explicit plugin shutdown hook to run.
    if (!plugin?.gateway?.stopAccount && lifecycleIds.size === 0) {
      return;
    }
    const cfg = getRuntimeConfig();
    const knownIds = new Set<string>([
      ...lifecycleIds,
      ...(plugin ? plugin.config.listAccountIds(cfg) : []),
    ]);
    if (accountId) {
      knownIds.clear();
      knownIds.add(accountId);
    }

    await Promise.all(
      Array.from(knownIds.values()).map(async (id) => {
        const abort = store.aborts.get(id);
        const task = store.tasks.get(id);
        if (!abort && !task && !plugin?.gateway?.stopAccount) {
          return;
        }
        const rKey = restartKey(channelId, id);
        if (manual) {
          manuallyStopped.add(rKey);
        }
        abort?.abort();
        const log = ensureChannelLog(channelId);
        const runtime = ensureChannelRuntime(channelId);
        if (plugin?.gateway?.stopAccount) {
          const account = plugin.config.resolveAccount(cfg, id);
          await plugin.gateway.stopAccount({
            cfg,
            accountId: id,
            account,
            runtime,
            abortSignal: abort?.signal ?? new AbortController().signal,
            log,
            getStatus: () => getRuntime(channelId, id),
            setStatus: (next) => setRuntime(channelId, id, next),
          });
        }
        const stoppedCleanly = await waitForChannelStopGracefully(
          task,
          CHANNEL_STOP_ABORT_TIMEOUT_MS,
        );
        if (!stoppedCleanly) {
          log.warn?.(
            `[${id}] channel stop exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms after abort; continuing shutdown`,
          );
          const stoppedPatch = {
            restartPending: !manual,
            lastError: `channel stop timed out after ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms`,
          };
          if (manual) {
            setRuntime(channelId, id, {
              accountId: id,
              running: true,
              ...stoppedPatch,
            });
          } else {
            setStoppedRuntime(channelId, id, stoppedPatch);
          }
          if (!manual) {
            recoveryStopTimedOut.add(rKey);
          }
          return;
        }
        recoveryStopTimedOut.delete(rKey);
        recoveryStartRequested.delete(rKey);
        store.aborts.delete(id);
        store.tasks.delete(id);
        setStoppedRuntime(channelId, id, {
          restartPending: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startChannels = async () => {
    let releaseAccountStarts: (() => void) | undefined;
    const deferAccountStartUntil =
      opts.deferStartupAccountStartsUntil ??
      (startupTrace
        ? new Promise<void>((resolve) => {
            releaseAccountStarts = () => {
              const handle = setImmediate(resolve);
              handle.unref?.();
            };
          })
        : undefined);
    try {
      await runTasksWithConcurrency({
        limit: CHANNEL_STARTUP_CONCURRENCY,
        tasks: [...listChannelPlugins()].map((plugin) => async () => {
          try {
            await measureStartup(`channels.${plugin.id}.start`, () =>
              startChannelInternal(
                plugin.id,
                undefined,
                deferAccountStartUntil ? { deferAccountStartUntil } : {},
              ),
            );
          } catch (err) {
            ensureChannelLog(plugin.id).error?.(
              `[${plugin.id}] channel startup failed: ${formatErrorMessage(err)}`,
            );
          }
        }),
      });
    } finally {
      releaseAccountStarts?.();
    }
  };

  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return;
    }
    const cfg = getRuntimeConfig();
    const resolvedId =
      accountId ??
      resolveChannelDefaultAccountId({
        plugin,
        cfg,
      });
    const current = getRuntime(channelId, resolvedId);
    const next: ChannelAccountSnapshot = {
      accountId: resolvedId,
      running: false,
      restartPending: false,
      lastError: cleared ? "logged out" : current.lastError,
    };
    if (typeof current.connected === "boolean") {
      next.connected = false;
    }
    setRuntime(channelId, resolvedId, next);
  };

  const getRuntimeSnapshot = (): ChannelRuntimeSnapshot => {
    const cfg = getRuntimeConfig();
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    for (const plugin of listChannelPlugins()) {
      const store = getStore(plugin.id);
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: Record<string, ChannelAccountSnapshot> = {};
      for (const id of accountIds) {
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        const described = plugin.config.describeAccount?.(account, cfg);
        const current = store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id);
        const next = { ...current, accountId: id };
        next.enabled = enabled;
        applyDescribedAccountFields(next, described);
        const configured = described?.configured;
        if (!next.running) {
          if (!enabled) {
            next.lastError ??= plugin.config.disabledReason?.(account, cfg) ?? "disabled";
          } else if (configured === false) {
            next.lastError ??= plugin.config.unconfiguredReason?.(account, cfg) ?? "not configured";
          }
        }
        accounts[id] = next;
      }
      const defaultAccount =
        accounts[defaultAccountId] ?? cloneDefaultRuntime(plugin.id, defaultAccountId);
      channels[plugin.id] = defaultAccount;
      channelAccounts[plugin.id] = accounts;
    }
    return { channels, channelAccounts };
  };

  const isManuallyStoppedFlag = (channelId: ChannelId, accountId: string): boolean => {
    return manuallyStopped.has(restartKey(channelId, accountId));
  };

  const resetRestartAttemptsForTest = (channelId: ChannelId, accountId: string): void => {
    restarts.delete(restartKey(channelId, accountId));
  };

  return {
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
    setAutostartSuppression: (suppression) => {
      autostartSuppression = suppression;
    },
    getAutostartSuppression: () => autostartSuppression,
    markChannelLoggedOut,
    isManuallyStopped: isManuallyStoppedFlag,
    resetRestartAttempts: resetRestartAttemptsForTest,
    isHealthMonitorEnabled,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

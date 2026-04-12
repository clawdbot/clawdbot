import type { ChannelRuntimeSurface } from "../channels/plugins/channel-runtime-surface.types.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { type ChannelId, getChannelPlugin, listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { startChannelApprovalHandlerBootstrap } from "../infra/approval-handler-bootstrap.js";
import { type BackoffPolicy, computeBackoff, sleepWithAbort } from "../infra/backoff.js";
import { createTaskScopedChannelRuntime } from "../infra/channel-runtime-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveAccountEntry, resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
  normalizeOptionalAccountId,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ChannelRuntimeSnapshot } from "./server-channel-runtime.types.js";
export type { ChannelRuntimeSnapshot };

const CHANNEL_RESTART_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 5 * 60_000,
  factor: 2,
  jitter: 0.1,
};
const MAX_RESTART_ATTEMPTS = 10;

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

type ChannelRuntimeStore = {
  aborts: Map<string, AbortController>;
  starting: Map<string, Promise<void>>;
  tasks: Map<string, Promise<unknown>>;
  runtimes: Map<string, ChannelAccountSnapshot>;
};

type HealthMonitorConfig = {
  healthMonitor?: {
    enabled?: boolean;
  };
};

type ChannelHealthMonitorConfig = HealthMonitorConfig & {
  accounts?: Record<string, HealthMonitorConfig>;
};

function createRuntimeStore(): ChannelRuntimeStore {
  return {
    aborts: new Map(),
    starting: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
  };
}

function isAccountEnabled(account: unknown): boolean {
  if (!account || typeof account !== "object") {
    return true;
  }
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
}

function resolveDefaultRuntime(channelId: ChannelId): ChannelAccountSnapshot {
  const plugin = getChannelPlugin(channelId);
  return plugin?.status?.defaultRuntime ?? { accountId: DEFAULT_ACCOUNT_ID };
}

function cloneDefaultRuntime(channelId: ChannelId, accountId: string): ChannelAccountSnapshot {
  return { ...resolveDefaultRuntime(channelId), accountId };
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
  loadConfig: () => OpenClawConfig;
  channelLogs: Record<ChannelId, SubsystemLogger>;
  channelRuntimeEnvs: Record<ChannelId, RuntimeEnv>;
  /**
   * Optional channel runtime helpers for external channel plugins.
   *
   * When provided, this value is passed to all channel plugins via the
   * `channelRuntime` field in `ChannelGatewayContext`, enabling external
   * plugins to access advanced Plugin SDK features (AI dispatch, routing,
   * text processing, etc.).
   *
   * Built-in channels (slack, discord, telegram) typically don't use this
   * because they can directly import internal modules from the monorepo.
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
   *   loadConfig,
   *   channelLogs,
   *   channelRuntimeEnvs,
   *   channelRuntime: createPluginRuntime().channel,
   * });
   * ```
   *
   * @since Plugin SDK 2026.2.19
   * @see {@link ChannelGatewayContext.channelRuntime}
   */
  channelRuntime?: ChannelRuntimeSurface;
  /**
   * Lazily resolves optional channel runtime helpers for external channel plugins.
   *
   * Use this when the caller wants to avoid instantiating the full plugin channel
   * runtime during gateway startup. The manager only needs the runtime surface once
   * a channel account actually starts. The resolved value must be a real
   * `createPluginRuntime().channel` surface.
   */
  resolveChannelRuntime?: () => ChannelRuntimeSurface;
};

type StartChannelOptions = {
  preserveRestartAttempts?: boolean;
  preserveManualStop?: boolean;
};

export type ChannelManager = {
  getRuntimeSnapshot: () => ChannelRuntimeSnapshot;
  startChannels: () => Promise<void>;
  startChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  stopChannel: (channel: ChannelId, accountId?: string) => Promise<void>;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
  isHealthMonitorEnabled: (channelId: ChannelId, accountId: string) => boolean;
};

// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager {
  const { loadConfig, channelLogs, channelRuntimeEnvs, channelRuntime, resolveChannelRuntime } =
    opts;

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();
  // Tracks restart attempts per channel:account. Reset on successful start.
  const restartAttempts = new Map<string, number>();
  // Tracks accounts that were manually stopped so we don't auto-restart them.
  const manuallyStopped = new Set<string>();

  const restartKey = (channelId: ChannelId, accountId: string) => `${channelId}:${accountId}`;

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
    const cfg = loadConfig();
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
      channelLogs[channelId].warn?.(
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

  const getChannelRuntime = (): ChannelRuntimeSurface | undefined => {
    return channelRuntime ?? resolveChannelRuntime?.();
  };

  const startChannelInternal = async (
    channelId: ChannelId,
    accountId?: string,
    opts: StartChannelOptions = {},
  ) => {
    const plugin = getChannelPlugin(channelId);
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      return;
    }
    const { preserveRestartAttempts = false, preserveManualStop = false } = opts;
    const cfg = loadConfig();
    resetDirectoryCache({ channel: channelId, accountId });
    const store = getStore(channelId);
    const accountIds = accountId ? [accountId] : plugin.config.listAccountIds(cfg);
    if (accountIds.length === 0) {
      return;
    }

    await Promise.all(
      accountIds.map(async (id) => {
        if (store.tasks.has(id)) {
          return;
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
        const log = channelLogs[channelId];
        let scopedChannelRuntime: ReturnType<typeof createTaskScopedChannelRuntime> | null = null;
        let channelRuntimeForTask: ChannelRuntimeSurface | undefined;
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
          scopedChannelRuntime = createTaskScopedChannelRuntime({
            channelRuntime: getChannelRuntime(),
          });
          channelRuntimeForTask = scopedChannelRuntime.channelRuntime;
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
            configured = await plugin.config.isConfigured(account, cfg);
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

          const rKey = restartKey(channelId, id);
          if (!preserveManualStop) {
            manuallyStopped.delete(rKey);
          }

          if (abort.signal.aborted || manuallyStopped.has(rKey)) {
            setRuntime(channelId, id, {
              accountId: id,
              running: false,
              restartPending: false,
              lastStopAt: Date.now(),
            });
            return;
          }

          if (!preserveRestartAttempts) {
            restartAttempts.delete(rKey);
          }
          stopApprovalBootstrap = await startChannelApprovalHandlerBootstrap({
            plugin,
            cfg,
            accountId: id,
            channelRuntime: channelRuntimeForTask,
            logger: log,
          });
          setRuntime(channelId, id, {
            accountId: id,
            enabled: true,
            configured: true,
            running: true,
            restartPending: false,
            lastStartAt: Date.now(),
            lastError: null,
            reconnectAttempts: preserveRestartAttempts ? (restartAttempts.get(rKey) ?? 0) : 0,
          });
          const task = Promise.resolve().then(() =>
            startAccount({
              cfg,
              accountId: id,
              account,
              runtime: channelRuntimeEnvs[channelId],
              abortSignal: abort.signal,
              log,
              getStatus: () => getRuntime(channelId, id),
              setStatus: (next) => setRuntime(channelId, id, next),
              ...(channelRuntimeForTask ? { channelRuntime: channelRuntimeForTask } : {}),
            }),
          );
          const trackedPromise = task
            .catch((err) => {
              const message = formatErrorMessage(err);
              setRuntime(channelId, id, { accountId: id, lastError: message });
              log.error?.(`[${id}] channel exited: ${message}`);
            })
            .finally(async () => {
              await cleanupTaskScopedApprovalRuntime("channel cleanup failed");
              setRuntime(channelId, id, {
                accountId: id,
                running: false,
                lastStopAt: Date.now(),
              });
            })
            .then(async () => {
              if (manuallyStopped.has(rKey)) {
                return;
              }
              const attempt = (restartAttempts.get(rKey) ?? 0) + 1;
              restartAttempts.set(rKey, attempt);
              if (attempt > MAX_RESTART_ATTEMPTS) {
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: false,
                  reconnectAttempts: attempt,
                });
                log.error?.(`[${id}] giving up after ${MAX_RESTART_ATTEMPTS} restart attempts`);
                return;
              }
              const delayMs = computeBackoff(CHANNEL_RESTART_POLICY, attempt);
              log.info?.(
                `[${id}] auto-restart attempt ${attempt}/${MAX_RESTART_ATTEMPTS} in ${Math.round(delayMs / 1000)}s`,
              );
              setRuntime(channelId, id, {
                accountId: id,
                restartPending: true,
                reconnectAttempts: attempt,
              });
              try {
                await sleepWithAbort(delayMs, abort.signal);
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
          handedOffTask = true;
          store.tasks.set(id, trackedPromise);
        } catch (error) {
          if (!handedOffTask) {
            setRuntime(channelId, id, {
              accountId: id,
              running: false,
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
    );
  };

  const startChannel = async (channelId: ChannelId, accountId?: string) => {
    await startChannelInternal(channelId, accountId);
  };

  const stopChannel = async (channelId: ChannelId, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    const store = getStore(channelId);
    // Fast path: nothing running and no explicit plugin shutdown hook to run.
    if (!plugin?.gateway?.stopAccount && store.aborts.size === 0 && store.tasks.size === 0) {
      return;
    }
    const cfg = loadConfig();
    const knownIds = new Set<string>([
      ...store.aborts.keys(),
      ...store.starting.keys(),
      ...store.tasks.keys(),
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
        manuallyStopped.add(restartKey(channelId, id));
        abort?.abort();
        if (plugin?.gateway?.stopAccount) {
          const account = plugin.config.resolveAccount(cfg, id);
          await plugin.gateway.stopAccount({
            cfg,
            accountId: id,
            account,
            runtime: channelRuntimeEnvs[channelId],
            abortSignal: abort?.signal ?? new AbortController().signal,
            log: channelLogs[channelId],
            getStatus: () => getRuntime(channelId, id),
            setStatus: (next) => setRuntime(channelId, id, next),
          });
        }
        try {
          await task;
        } catch {
          // ignore
        }
        store.aborts.delete(id);
        store.tasks.delete(id);
        setRuntime(channelId, id, {
          accountId: id,
          running: false,
          restartPending: false,
          lastStopAt: Date.now(),
        });
      }),
    );
  };

  const startChannels = async () => {
    for (const plugin of listChannelPlugins()) {
      try {
        await startChannel(plugin.id);
      } catch (err) {
        channelLogs[plugin.id]?.error?.(
          `[${plugin.id}] channel startup failed: ${formatErrorMessage(err)}`,
        );
      }
    }
  };

  const markChannelLoggedOut = (channelId: ChannelId, cleared: boolean, accountId?: string) => {
    const plugin = getChannelPlugin(channelId);
    if (!plugin) {
      return;
    }
    const cfg = loadConfig();
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
    const cfg = loadConfig();
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

  const isManuallyStopped_ = (channelId: ChannelId, accountId: string): boolean => {
    return manuallyStopped.has(restartKey(channelId, accountId));
  };

  const resetRestartAttempts_ = (channelId: ChannelId, accountId: string): void => {
    restartAttempts.delete(restartKey(channelId, accountId));
  };

  return {
    getRuntimeSnapshot,
    startChannels,
    startChannel,
    stopChannel,
    markChannelLoggedOut,
    isManuallyStopped: isManuallyStopped_,
    resetRestartAttempts: resetRestartAttempts_,
    isHealthMonitorEnabled,
  };
}

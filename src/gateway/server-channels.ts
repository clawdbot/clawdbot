// Gateway channel manager.
// Starts, stops, restarts, and snapshots plugin channel account runtimes.
import { RetrySupervisor } from "../../packages/retry/src/index.js";
import { isChannelAccountExplicitlyDisabled } from "../channels/account-config-enabled.js";
import { getCredentialUnavailableDiagnostics } from "../channels/account-snapshot-fields.js";
import { buildChannelAccountSnapshotFromInspection } from "../channels/account-summary.js";
import { isChannelIngressUnavailableError } from "../channels/message/ingress-unavailable.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import {
  getLoadedChannelPluginEntryById,
  listLoadedChannelPluginsForRegistry,
} from "../channels/plugins/registry-loaded.js";
import type { ChannelGatewayContext } from "../channels/plugins/types.adapters.js";
import type {
  ChannelAccountSnapshot,
  ChannelId,
  ChannelPlugin,
} from "../channels/plugins/types.public.js";
import {
  applyChannelAccountState,
  resolveChannelAccountState,
  resolveUnavailableChannelAccountSnapshot,
} from "../channels/status/account-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { withGatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime-context.js";
import type { GatewayNativeApprovalMethod } from "../infra/approval-gateway-runtime-methods.js";
import type { GatewayNativeApprovalRuntime } from "../infra/approval-gateway-runtime.types.js";
import { startChannelApprovalHandlerBootstrap } from "../infra/approval-handler-bootstrap.js";
import { type BackoffPolicy, sleepWithAbort } from "../infra/backoff.js";
import {
  createTaskScopedChannelRuntime,
  registerChannelRuntimeContext,
} from "../infra/channel-runtime-context.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatGatewayCrashLoopManualChannelStartHint } from "../infra/gateway-boot-lifecycle.js";
import { resetDirectoryCache } from "../infra/outbound/target-resolver.js";
import {
  createSubsystemLogger,
  runtimeForLogger,
  type SubsystemLogger,
} from "../logging/subsystem.js";
import {
  createPluginRuntimeCapabilityLease,
  type PluginRuntimeCapabilityLease,
} from "../plugins/capability-lease.js";
import { withPluginHttpRouteRegistry } from "../plugins/http-registry.js";
import type { PluginRegistry } from "../plugins/registry.js";
import { withPluginRuntimeRegistryScope } from "../plugins/runtime/gateway-request-scope.js";
import type { PluginRuntimeChannel } from "../plugins/runtime/types-channel.js";
import { runOutsideGatewayRootWorkAdmission } from "../process/gateway-work-admission.js";
import { resolveAccountEntry, resolveNormalizedAccountEntry } from "../routing/account-lookup.js";
import { normalizeAccountId, normalizeOptionalAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  assertSecretOwnerAvailable,
  clearActiveCredentialDegradedOwner,
  setActiveCredentialDegradedOwner,
} from "../secrets/runtime-degraded-state.js";
import { isAccountEnabled } from "../shared/account-enabled.js";
import { createDeferredCore } from "../shared/deferred.js";
import { runTasksWithConcurrency } from "../utils/run-with-concurrency.js";
import type {
  ChannelAccountStartOutcome,
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
// Private context key carried through the generic Plugin SDK registry. This is
// not a new public capability surface; only the host installs its authority.
const CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY = "approval.gateway";
function waitForChannelStartupHandoff(): Promise<void> {
  return new Promise((resolve) => {
    const handle = setImmediate(resolve);
    handle.unref?.();
  });
}

type ChannelAccountLifetime = {
  abort: AbortController;
  capabilityLease: PluginRuntimeCapabilityLease;
  teardown?: {
    context: Omit<ChannelGatewayContext, "setStatus">;
    run: NonNullable<NonNullable<ChannelPlugin["gateway"]>["stopAccount"]>;
  };
};

type ChannelRuntimeStore = {
  lifetimes: Map<string, ChannelAccountLifetime>;
  starting: Map<string, Promise<void>>;
  stops: Map<string, ChannelAccountStopState>;
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
  delete next.lifecycle;

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
    lifetimes: new Map(),
    starting: new Map(),
    stops: new Map(),
    tasks: new Map(),
    runtimes: new Map(),
  };
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

type ChannelManagerOptions = {
  getRuntimeConfig: () => OpenClawConfig;
  getPluginRegistry: () => PluginRegistry;
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
   *   getPluginRegistry,
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
  startupTrace?: GatewayStartupTrace;
  deferStartupAccountStartsUntil?: Promise<void>;
  getNativeApprovalRuntime?: () => GatewayNativeApprovalRuntime | undefined;
  ambientAutostartSuppressedChannelIds?: ReadonlySet<string>;
  tryRecoverAutostartSuppression?: () => boolean;
  isClosing?: () => boolean;
};

type StopChannelOptions = {
  manual?: boolean;
};

type ChannelAccountStopOutcome = { status: "fulfilled" } | { status: "rejected"; error: unknown };

type ChannelAccountStopState =
  | { status: "stopping"; attempt: Promise<ChannelAccountStopOutcome> }
  | Extract<ChannelAccountStopOutcome, { status: "rejected" }>;

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
  pauseChannelStarts: () => (outcome: "published" | "rollback") => void;
  startChannels: () => Promise<void>;
  startChannel: (
    channel: ChannelId,
    accountId?: string,
    opts?: StartChannelOptions,
  ) => Promise<ReadonlyMap<string, ChannelAccountStartOutcome>>;
  stopChannel: (channel: ChannelId, accountId?: string, opts?: StopChannelOptions) => Promise<void>;
  setAutostartSuppression: (suppression: ChannelAutostartSuppression | null) => void;
  getAutostartSuppression: () => ChannelAutostartSuppression | null;
  recoverAutostartSuppression: () => Promise<boolean>;
  setAmbientAutostartSuppressedChannelIds: (channelIds: ReadonlySet<string>) => void;
  isAmbientAutostartSuppressed: (channelId: string) => boolean;
  markChannelLoggedOut: (channelId: ChannelId, cleared: boolean, accountId?: string) => void;
  isManuallyStopped: (channelId: ChannelId, accountId: string) => boolean;
  isAutoRestartScheduled: (channelId: ChannelId, accountId: string) => boolean;
  resetRestartAttempts: (channelId: ChannelId, accountId: string) => void;
  isHealthMonitorEnabled: (channelId: ChannelId, accountId: string) => boolean;
};

// Channel docking: lifecycle hooks (`plugin.gateway`) flow through this manager.
export function createChannelManager(opts: ChannelManagerOptions): ChannelManager & {
  pruneInactiveChannelAccountState: (activeChannelIds: ReadonlySet<ChannelId>) => void;
  resolveRuntimeAccountId: (channelId: ChannelId, accountId: string) => string | undefined;
} {
  const {
    getRuntimeConfig,
    channelLogs,
    channelRuntimeEnvs,
    channelRuntime,
    resolveChannelRuntime,
    getPluginRegistry,
    startupTrace,
  } = opts;

  // Each operation retains its Gateway's registry; later retries select its successor.
  // Ambient request or process registries may belong to another live Gateway.
  const withRegistry = <T>(run: (registry: PluginRegistry) => T): T => {
    const registry = getPluginRegistry();
    return withPluginRuntimeRegistryScope(registry, () => run(registry));
  };
  const getChannelPlugin = (channelId: ChannelId) =>
    getLoadedChannelPluginEntryById(channelId, getPluginRegistry())?.plugin;
  const cloneDefaultRuntime = (
    channelId: ChannelId,
    accountId: string,
  ): ChannelAccountSnapshot => ({
    ...getChannelPlugin(channelId)?.status?.defaultRuntime,
    accountId,
  });

  const channelStores = new Map<ChannelId, ChannelRuntimeStore>();
  let channelStartPause: ReturnType<ChannelManager["pauseChannelStarts"]> | undefined;
  const restarts = new Map<string, RetrySupervisor>();
  // Tracks accounts that were manually stopped so we don't auto-restart them.
  const manuallyStopped = new Set<string>();
  const recoveryStopTimedOut = new Set<string>();
  const recoveryStartRequested = new Set<string>();
  // Accounts whose crash recovery is already owned by the retry supervisor below
  // (backoff sleep plus its replacement start). `restartPending` cannot answer
  // this: the timed-out-stop recovery sets it too, and that one needs the health
  // monitor to keep driving it.
  const pendingAutoRestarts = new Set<string>();
  let autostartSuppression: ChannelAutostartSuppression | null = null;
  let ambientAutostartSuppressedChannelIds = new Set(
    opts.ambientAutostartSuppressedChannelIds ?? [],
  );

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
    const hasExplicitReadyRecovery =
      Object.hasOwn(patch, "lifecycle") &&
      patch.lifecycle === "ready" &&
      Object.hasOwn(patch, "terminalDisconnect") &&
      patch.terminalDisconnect === undefined;
    // Weaker/derived signals never clear a terminal diagnosis. Gateway-owned starting still
    // begins a new lifecycle; a channel-authored explicit ready + terminal clear proves recovery.
    const lifecycle =
      current.lifecycle === "blocked" &&
      current.terminalDisconnect === true &&
      patch.lifecycle !== "starting" &&
      !hasExplicitReadyRecovery
        ? "blocked"
        : (patch.lifecycle ??
          (patch.restartPending === true
            ? "recovering"
            : patch.connected === true
              ? "ready"
              : undefined));
    const next = { ...current, ...patch, ...(lifecycle ? { lifecycle } : {}), accountId };
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
      lifecycle: patch.restartPending === true ? "recovering" : "stopped",
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
  const createAccountContext = (
    channelId: ChannelId,
    accountId: string,
    cfg: OpenClawConfig,
    account: unknown,
    abortSignal: AbortSignal,
  ): Omit<ChannelGatewayContext, "setStatus"> => ({
    cfg,
    accountId,
    account,
    abortSignal,
    runtime: ensureChannelRuntime(channelId),
    log: ensureChannelLog(channelId),
    getStatus: () => getRuntime(channelId, accountId),
  });
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
        store.lifetimes.has(id) ||
        store.starting.has(id) ||
        store.stops.has(id) ||
        store.tasks.has(id)
      ) {
        continue;
      }
      store.runtimes.delete(id);
      clearActiveCredentialDegradedOwner("account", restartKey(channelId, normalizeAccountId(id)));
      restarts.delete(restartKey(channelId, id));
      manuallyStopped.delete(restartKey(channelId, id));
      recoveryStartRequested.delete(restartKey(channelId, id));
    }
  };

  const pruneInactiveChannelAccountState = (activeChannelIds: ReadonlySet<ChannelId>): void => {
    for (const [channelId, store] of channelStores) {
      if (!activeChannelIds.has(channelId)) {
        evictStaleChannelAccountState(channelId, store, []);
      }
    }
  };

  const startChannelProcessOwned = async (
    registry: PluginRegistry,
    channelId: ChannelId,
    accountId?: string,
    optsValue: StartChannelOptions = {},
  ): Promise<ReadonlyMap<string, ChannelAccountStartOutcome>> => {
    const assertStartCurrent = () => {
      if (channelStartPause || registry !== getPluginRegistry()) {
        throw new Error("Channel plugins are reloading; retry the start after reload completes.");
      }
    };
    assertStartCurrent();
    const registration = getLoadedChannelPluginEntryById(channelId, registry);
    const plugin = registration?.plugin;
    const startAccount = plugin?.gateway?.startAccount;
    if (!startAccount) {
      return accountId
        ? new Map([[accountId, { status: "skipped", reason: "unsupported" }]])
        : new Map();
    }
    const { preserveRestartAttempts = false, preserveManualStop = false } = optsValue;
    const cfg = getRuntimeConfig();
    resetDirectoryCache({ cfg, channel: channelId, accountId });
    const store = getStore(channelId);
    const accountIds = accountId
      ? [accountId]
      : await measureStartup(`channels.${channelId}.list-accounts`, () =>
          plugin.config.listAccountIds(cfg),
        );
    assertStartCurrent();
    if (!accountId) {
      evictStaleChannelAccountState(channelId, store, accountIds);
    }
    if (accountIds.length === 0) {
      return new Map();
    }
    if (autostartSuppression && optsValue.manual !== true) {
      // Safe mode must block every automatic channel start surface; otherwise
      // config reloads can undo the crash-loop breaker while operators inspect.
      const suffix = accountId ? ` account ${accountId}` : "";
      ensureChannelLog(channelId).warn?.(
        `channel autostart suppressed by crash-loop breaker; refusing automatic start for ${channelId}${suffix}. ${formatGatewayCrashLoopManualChannelStartHint({ channelId, ...(accountId ? { accountId } : {}) })}`,
      );
      for (const id of accountIds) {
        setStoppedRuntime(channelId, id, {
          restartPending: false,
          lastError: autostartSuppression.message,
        });
      }
      return new Map(
        accountIds.map((id) => [
          id,
          { status: "skipped", reason: "autostart-suppressed" } as const,
        ]),
      );
    }
    if (ambientAutostartSuppressedChannelIds.has(channelId) && optsValue.manual !== true) {
      for (const id of accountIds) {
        setStoppedRuntime(channelId, id, {
          restartPending: false,
          lastError:
            "ambient channel credentials suppressed; configure the channel or start the gateway with --ambient-channels",
        });
      }
      return new Map(
        accountIds.map((id) => [id, { status: "skipped", reason: "ambient-suppressed" } as const]),
      );
    }

    const startOutcomes = new Map<string, ChannelAccountStartOutcome>();
    const startup = await runTasksWithConcurrency({
      limit: CHANNEL_STARTUP_CONCURRENCY,
      tasks: accountIds.map((id) => async () => {
        assertStartCurrent();
        const rKey = restartKey(channelId, id);
        // Record start intent before waiting; a later stop must survive cancelled preparation.
        if (!preserveManualStop && !store.stops.has(id)) {
          manuallyStopped.delete(rKey);
        }
        // A stopped preparation may never publish a task. Reacquire its slot only
        // after cleanup, rechecking ownership when other starts were also waiting.
        for (;;) {
          // An in-flight or failed plugin teardown may still own resources. Only
          // the last queued attempt or a later successful stop clears this gate.
          if (store.stops.has(id)) {
            startOutcomes.set(id, { status: "retry", reason: "stop-in-flight" });
            return;
          }
          if (store.tasks.has(id)) {
            let clearedTimedOutRecoveryTask = false;
            if (recoveryStopTimedOut.has(rKey)) {
              if (manuallyStopped.has(rKey)) {
                startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
                return;
              }
              // When a previous stop timed out and the health monitor is
              // requesting recovery again, clean up the stuck task so the
              // channel can actually restart instead of staying in limbo.
              if (recoveryStartRequested.has(rKey)) {
                recoveryStopTimedOut.delete(rKey);
                recoveryStartRequested.delete(rKey);
                restarts.delete(rKey);
                store.lifetimes.get(id)?.capabilityLease.revoke();
                store.lifetimes.delete(id);
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
                startOutcomes.set(id, { status: "retry", reason: "task-owned" });
                return;
              }
            }
            if (!clearedTimedOutRecoveryTask) {
              startOutcomes.set(id, { status: "retry", reason: "task-owned" });
              return;
            }
          }
          const existingStart = store.starting.get(id);
          if (!existingStart) {
            break;
          }
          await existingStart;
          assertStartCurrent();
        }

        const startGate = createDeferredCore();
        store.starting.set(id, startGate.promise);

        // Reserve the account before the first await so overlapping start calls
        // cannot race into duplicate provider boots for the same account.
        const abort = new AbortController();
        const capabilityLease = createPluginRuntimeCapabilityLease("channel account");
        const lifetime: ChannelAccountLifetime = { abort, capabilityLease };
        store.lifetimes.set(id, lifetime);
        let handedOffTask = false;
        const log = ensureChannelLog(channelId);
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
        const skipDisabledAccount = () => {
          setRuntime(channelId, id, {
            accountId: id,
            enabled: false,
            running: false,
            restartPending: false,
          });
          startOutcomes.set(id, { status: "skipped", reason: "disabled" });
        };

        try {
          // Reject active accounts before plugin resolution so an explicit failed SecretRef cannot
          // drift into a channel-specific environment or file fallback.
          const secretOwnerId = `${channelId}:${normalizeAccountId(id)}`;
          clearActiveCredentialDegradedOwner("account", secretOwnerId);
          // Explicitly disabled accounts need no credentials. Unlisted requests still go
          // through the plugin resolver so a disable cannot hide account-selection errors.
          if (
            isChannelAccountExplicitlyDisabled({ cfg, channel: channelId, accountId: id }) &&
            plugin.config
              .listAccountIds(cfg)
              .some((listed) => normalizeAccountId(listed) === normalizeAccountId(id))
          ) {
            skipDisabledAccount();
            return;
          }
          try {
            assertSecretOwnerAvailable("account", secretOwnerId);
          } catch (error) {
            if (!optsValue.skipUnavailableAccounts) {
              throw error;
            }
            // Only this snapshot-owned assertion is an expected cold reload
            // outcome; plugin startup and credential-file inspection still fail.
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastError: formatErrorMessage(error),
            });
            startOutcomes.set(id, { status: "skipped", reason: "secret-unavailable" });
            return;
          }
          const account = plugin.config.resolveAccount(cfg, id);
          const accountContext = createAccountContext(channelId, id, cfg, account, abort.signal);
          if (plugin.gateway?.stopAccount) {
            lifetime.teardown = {
              context: accountContext,
              run: plugin.gateway.stopAccount.bind(plugin.gateway),
            };
          }
          const described = plugin.config.describeAccount?.(account, cfg);
          const enabled = plugin.config.isEnabled
            ? plugin.config.isEnabled(account, cfg)
            : isAccountEnabled(account);
          if (!enabled) {
            skipDisabledAccount();
            return;
          }

          const credentialDiagnostics = getCredentialUnavailableDiagnostics(account);
          if (credentialDiagnostics.length > 0) {
            setActiveCredentialDegradedOwner({
              ownerKind: "account",
              ownerId: secretOwnerId,
              state: "unavailable",
              paths: credentialDiagnostics.map((diagnostic) => diagnostic.path),
              refKeys: [],
              reason: "credential file is unavailable",
            });
            assertSecretOwnerAvailable("account", secretOwnerId);
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
              linked: undefined,
              running: false,
              restartPending: false,
            });
            startOutcomes.set(id, { status: "skipped", reason: "unconfigured" });
            return;
          }
          setRuntime(channelId, id, {
            accountId: id,
            enabled: true,
            configured: true,
            ...(plugin.config.isLinked ? { linked: undefined } : {}),
          });

          const fallbackLinked = described?.linked ?? getRuntime(channelId, id).linked;
          const linkState = plugin.config.isLinked
            ? await measureStartup(`channels.${channelId}.is-linked`, () =>
                plugin.config.isLinked!(account, cfg),
              )
            : fallbackLinked === true
              ? "linked"
              : fallbackLinked === false
                ? "not-linked"
                : undefined;
          if (linkState === "not-linked" || linkState === "unknown") {
            setRuntime(channelId, id, {
              accountId: id,
              enabled: true,
              linked: linkState === "not-linked" ? false : undefined,
              running: false,
              restartPending: false,
            });
            startOutcomes.set(id, { status: "skipped", reason: "unlinked" });
            return;
          }

          if (abort.signal.aborted || manuallyStopped.has(rKey)) {
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastStopAt: Date.now(),
            });
            startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
            return;
          }

          scopedChannelRuntime = await measureStartup(`channels.${channelId}.runtime`, async () =>
            createTaskScopedChannelRuntime({
              channelRuntime:
                registration?.resolveChannelRuntime?.() ?? (await getChannelRuntime()),
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
                  gatewayRuntime: opts.getNativeApprovalRuntime?.(),
                  logger: log,
                }),
            );
          } catch (error) {
            log.error?.(`[${id}] native approval bootstrap failed: ${formatErrorMessage(error)}`);
          }
          // Preparation can outlive a registry replacement or an operator stop. Never publish
          // its predecessor task after the replacement has admitted new account lifetimes.
          assertStartCurrent();
          if (abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.()) {
            startOutcomes.set(id, { status: "skipped", reason: "manual-stop" });
            return;
          }
          let channelRunDurationMs: number | undefined;
          setRuntime(channelId, id, {
            accountId: id,
            enabled: true,
            ...(linkState === "linked" ? { linked: true } : {}),
            running: true,
            lifecycle: "starting",
            restartPending: false,
            lastStartAt: Date.now(),
            lastError: null,
            // Runtime rows are patch-merged; prior ingress or terminal verdicts
            // must not poison a new lifecycle before its plugin reports status.
            ingressUnavailable: undefined,
            terminalDisconnect: undefined,
            reconnectAttempts: preserveRestartAttempts ? (restarts.get(rKey)?.attempts ?? 0) : 0,
          });
          const task = Promise.resolve().then(async () => {
            if (optsValue.deferAccountStartUntil) {
              await waitForDeferredAccountStart(optsValue.deferAccountStartUntil, abort.signal);
            } else if (startupTrace) {
              await waitForChannelStartupHandoff();
            }
            if (abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.()) {
              return;
            }
            const gatewayApprovalRuntime = opts.getNativeApprovalRuntime?.();
            if (channelRuntimeForTask && gatewayApprovalRuntime) {
              const approvalRuntime: Pick<GatewayNativeApprovalRuntime, "request"> = {
                request: async <T>(
                  method: GatewayNativeApprovalMethod,
                  requestParams: Record<string, unknown>,
                  requestOptions?: { clientDisplayName?: string },
                ): Promise<T> => {
                  if (method !== "approval.resolve") {
                    throw new Error(`channel approval runtime cannot dispatch ${method}`);
                  }
                  return await gatewayApprovalRuntime.request<T>(
                    "approval.resolve",
                    requestParams,
                    requestOptions,
                  );
                },
              };
              registerChannelRuntimeContext({
                channelRuntime: channelRuntimeForTask,
                channelId,
                accountId: id,
                capability: CHANNEL_APPROVAL_GATEWAY_RUNTIME_CONTEXT_CAPABILITY,
                context: approvalRuntime,
                abortSignal: abort.signal,
              });
            }
            let startAccountTask: ReturnType<typeof startAccount> | undefined;
            await measureStartup(`channels.${channelId}.start-account-handoff`, () => {
              if (abort.signal.aborted || manuallyStopped.has(rKey) || opts.isClosing?.()) {
                return;
              }
              const runStartAccount = () => {
                const startedAt = Date.now();
                const recordDuration = () => {
                  channelRunDurationMs = Date.now() - startedAt;
                };
                try {
                  return withGatewayNativeApprovalRuntime(opts.getNativeApprovalRuntime?.(), () =>
                    startAccount({
                      ...accountContext,
                      setStatus: (next) =>
                        isCurrentTask()
                          ? setRuntimeFromTaskStatus(channelId, id, next, abort.signal)
                          : getRuntime(channelId, id),
                      invalidateDirectoryCache: () =>
                        resetDirectoryCache({ cfg, channel: channelId, accountId: id }),
                      ...(channelRuntimeForTask ? { channelRuntime: channelRuntimeForTask } : {}),
                    }),
                  ).finally(recordDuration);
                } catch (error) {
                  recordDuration();
                  throw error;
                }
              };
              startAccountTask = withPluginHttpRouteRegistry(
                registry,
                runStartAccount,
                capabilityLease,
              );
            });
            if (!startAccountTask) {
              return;
            }
            await startAccountTask;
          });
          // Recovery can replace a timed-out task before the old promise settles.
          // Only the task that still owns the store slot may write lifecycle state.
          const trackedPromise = task
            .finally(() => capabilityLease.revoke())
            .then(() => {
              if (
                abort.signal.aborted ||
                manuallyStopped.has(rKey) ||
                opts.isClosing?.() ||
                !isCurrentTask()
              ) {
                return;
              }
              if (getRuntime(channelId, id).terminalDisconnect) {
                // Terminal status carries the operator-facing diagnosis and restart policy.
                // Do not replace it with a generic clean-exit error before policy consumes it.
                return;
              }
              const message = "channel exited without an error";
              setRuntime(channelId, id, { accountId: id, lastError: message });
              log.error?.(`[${id}] ${message}`);
            })
            .catch((err: unknown) => {
              if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
                return;
              }
              const message = formatErrorMessage(err);
              setRuntime(channelId, id, {
                accountId: id,
                lastError: message,
                // A channel that never armed its ingress admission is not "crashed":
                // outbound may work fine while inbound is silently dead. Record the
                // distinct dimension so health stops reading a live socket as healthy.
                ...(isChannelIngressUnavailableError(err) ? { ingressUnavailable: true } : {}),
              });
              log.error?.(`[${id}] channel exited: ${message}`);
            })
            .then(async () => {
              await cleanupTaskScopedApprovalRuntime("channel cleanup failed");
              // stopChannel owns the failed-teardown snapshot until a later
              // successful stop proves replacement is safe.
              if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
                return;
              }
              setStoppedRuntime(channelId, id, {
                lastStopAt: Date.now(),
              });
            })
            .then(async () => {
              if (!isCurrentTask() || store.stops.has(id) || opts.isClosing?.()) {
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
                  releaseTask();
                  return;
                }
                restarts.delete(rKey);
                log.info?.(`[${id}] restarting after timed-out channel stop completed`);
                setRuntime(channelId, id, {
                  accountId: id,
                  restartPending: true,
                  reconnectAttempts: 0,
                });
                releaseTask();
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
              pendingAutoRestarts.add(rKey);
              try {
                await sleepWithAbort(retry.delayMs, retry.signal);
                if (manuallyStopped.has(rKey) || opts.isClosing?.()) {
                  return;
                }
                releaseTask();
                await startChannelInternal(channelId, id, {
                  preserveRestartAttempts: true,
                  preserveManualStop: true,
                });
              } catch {
                // abort or startup failure — next crash will retry
              } finally {
                pendingAutoRestarts.delete(rKey);
              }
            })
            .finally(releaseTask);
          function releaseTask() {
            if (store.tasks.get(id) === trackedPromise) {
              store.tasks.delete(id);
            }
            // Failed or queued teardown retains the admitted context. Every terminal
            // task still aborts before replacement so no predecessor keeps authority.
            if (store.lifetimes.get(id) === lifetime && !store.stops.has(id)) {
              store.lifetimes.delete(id);
            }
            abort.abort();
          }
          function isCurrentTask() {
            return store.tasks.get(id) === trackedPromise;
          }
          handedOffTask = true;
          store.tasks.set(id, trackedPromise);
          startOutcomes.set(id, { status: "handed-off" });
        } catch (error) {
          if (!handedOffTask) {
            setStoppedRuntime(channelId, id, {
              restartPending: false,
              lastError: formatErrorMessage(error),
            });
          }
          throw error;
        } finally {
          if (!handedOffTask) {
            capabilityLease.revoke();
            await cleanupTaskScopedApprovalRuntime("channel startup cleanup failed");
          }
          if (!handedOffTask && store.lifetimes.get(id) === lifetime && !store.stops.has(id)) {
            store.lifetimes.delete(id);
          }
          if (store.starting.get(id) === startGate.promise) {
            store.starting.delete(id);
          }
          startGate.resolve();
        }
      }),
    });
    if (startup.hasError) {
      throw startup.firstError;
    }
    return startOutcomes;
  };

  // Channel lifetimes outlive the RPC or timer requesting startup, so their
  // provider, approval, cleanup, and restart descendants must be process-owned.
  const startChannelInternal: ChannelManager["startChannel"] = (...args) =>
    withRegistry((registry) =>
      runOutsideGatewayRootWorkAdmission(() => startChannelProcessOwned(registry, ...args)),
    );

  const stopChannelInRegistry = async (
    registry: PluginRegistry,
    channelId: ChannelId,
    accountId?: string,
    optsLocal: StopChannelOptions = {},
  ) => {
    const manual = optsLocal.manual ?? true;
    const plugin = getLoadedChannelPluginEntryById(channelId, registry)?.plugin;
    const store = getStore(channelId);
    const lifecycleIds = new Set<string>([
      ...store.lifetimes.keys(),
      ...store.starting.keys(),
      ...store.stops.keys(),
      ...store.tasks.keys(),
    ]);
    // Preserve no-enumeration channel-wide idle stops. An explicit account stop
    // must still commit manual intent before health monitoring can restart it.
    if (!accountId && lifecycleIds.size === 0) {
      return;
    }
    const cfg = getRuntimeConfig();
    const knownIds = new Set<string>(
      accountId
        ? [accountId]
        : [...lifecycleIds, ...(plugin ? plugin.config.listAccountIds(cfg) : [])],
    );

    // Gate replacement starts before teardown begins. Failures still reject only
    // after every sibling account has finished its independent lifecycle cleanup.
    const stopOutcomes = await Promise.all(
      Array.from(knownIds.values()).map(async (id): Promise<ChannelAccountStopOutcome> => {
        const rKey = restartKey(channelId, id);
        if (manual) {
          manuallyStopped.add(rKey);
        }

        const runStopAttempt = async (
          previousOutcome: ChannelAccountStopOutcome,
        ): Promise<ChannelAccountStopOutcome> => {
          const lifetime = store.lifetimes.get(id);
          const abort = lifetime?.abort;
          const task = store.tasks.get(id);
          if (!abort && !task && !plugin?.gateway?.stopAccount) {
            return previousOutcome;
          }
          abort?.abort();
          const log = ensureChannelLog(channelId);
          let outcome: ChannelAccountStopOutcome = { status: "fulfilled" };
          let capabilityLease: PluginRuntimeCapabilityLease | undefined;
          try {
            // Running and failed-stop accounts belong to their admitted plugin and config,
            // even after publication removes the account or replaces its registration.
            let teardown = lifetime?.teardown;
            if (!lifetime && plugin?.gateway?.stopAccount) {
              teardown = {
                context: createAccountContext(
                  channelId,
                  id,
                  cfg,
                  plugin.config.resolveAccount(cfg, id),
                  new AbortController().signal,
                ),
                run: plugin.gateway.stopAccount.bind(plugin.gateway),
              };
            }
            if (teardown) {
              const { context, run } = teardown;
              // The start task can settle before stopAccount. Shutdown routes need
              // their own lease, bounded by this stop attempt rather than that task.
              capabilityLease = createPluginRuntimeCapabilityLease("channel account stop");
              // A plugin stopAccount that never settles must not wedge every
              // stop-driven flow (health monitor sweeps, thaw recovery, reload).
              // Bound it like the task teardown below; the timed-out path flows
              // into the existing recoveryStopTimedOut two-call restart contract.
              let stopAttemptAbandoned = false;
              const runStopAccount = () =>
                run({
                  ...context,
                  setStatus: (next) => {
                    // A stop we abandoned may settle after a replacement started;
                    // its late writes must not repaint or tear down that account.
                    setRuntime(
                      channelId,
                      id,
                      stopAttemptAbandoned
                        ? sanitizeAbortedTaskStatusPatch(next, getRuntime(channelId, id))
                        : next,
                    );
                  },
                });
              const stopAccountAttempt = withPluginHttpRouteRegistry(
                registry,
                runStopAccount,
                capabilityLease,
              ).catch((error: unknown) => {
                if (stopAttemptAbandoned) {
                  log.warn?.(
                    `[${id}] abandoned stopAccount failed late: ${formatErrorMessage(error)}`,
                  );
                  return;
                }
                outcome = { status: "rejected", error };
                log.warn?.(`[${id}] stopAccount failed: ${formatErrorMessage(error)}`);
              });
              const stopAccountSettled = await waitForChannelStopGracefully(
                stopAccountAttempt,
                CHANNEL_STOP_ABORT_TIMEOUT_MS,
              );
              if (!stopAccountSettled) {
                stopAttemptAbandoned = true;
                log.warn?.(
                  `[${id}] stopAccount exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms; continuing stop`,
                );
              }
            }
          } catch (error) {
            outcome = { status: "rejected", error };
            log.warn?.(`[${id}] stopAccount failed: ${formatErrorMessage(error)}`);
          } finally {
            capabilityLease?.revoke();
          }
          const stoppedCleanly = await waitForChannelStopGracefully(
            task,
            CHANNEL_STOP_ABORT_TIMEOUT_MS,
          );
          if (!stoppedCleanly) {
            log.warn?.(
              `[${id}] channel stop exceeded ${CHANNEL_STOP_ABORT_TIMEOUT_MS}ms after abort; continuing shutdown`,
            );
          }
          if (outcome.status === "rejected") {
            recoveryStopTimedOut.delete(rKey);
            recoveryStartRequested.delete(rKey);
            if (stoppedCleanly && store.tasks.get(id) === task) {
              store.tasks.delete(id);
            }
            setRuntime(channelId, id, {
              accountId: id,
              running: true,
              restartPending: false,
              lastError: formatErrorMessage(outcome.error),
            });
            return outcome;
          }
          if (!stoppedCleanly) {
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
              recoveryStopTimedOut.add(rKey);
            }
            return outcome;
          }
          recoveryStopTimedOut.delete(rKey);
          recoveryStartRequested.delete(rKey);
          if (store.tasks.get(id) === task) {
            store.tasks.delete(id);
          }
          setStoppedRuntime(channelId, id, {
            restartPending: false,
            lastStopAt: Date.now(),
          });
          return outcome;
        };

        const currentStop = store.stops.get(id);
        const previousStop =
          currentStop?.status === "stopping"
            ? currentStop.attempt
            : Promise.resolve<ChannelAccountStopOutcome>(currentStop ?? { status: "fulfilled" });
        const stopAttempt = previousStop.then(runStopAttempt);
        store.stops.set(id, { status: "stopping", attempt: stopAttempt });
        const outcome = await stopAttempt;
        const latestStop = store.stops.get(id);
        if (latestStop?.status === "stopping" && latestStop.attempt === stopAttempt) {
          if (outcome.status === "rejected") {
            store.stops.set(id, outcome);
          } else {
            store.stops.delete(id);
            if (!store.tasks.has(id) && !store.starting.has(id)) {
              store.lifetimes.delete(id);
            }
          }
        }
        return outcome;
      }),
    );
    const failedStop = stopOutcomes.find((outcome) => outcome.status === "rejected");
    if (failedStop?.status === "rejected") {
      throw failedStop.error;
    }
  };

  const stopChannel: ChannelManager["stopChannel"] = (...args) =>
    withRegistry((registry) => stopChannelInRegistry(registry, ...args));

  const startChannelsWithOptions = async (startOptions: StartChannelOptions = {}) => {
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
        tasks: listLoadedChannelPluginsForRegistry(getPluginRegistry()).map(
          (plugin) => async () => {
            try {
              await measureStartup(`channels.${plugin.id}.start`, () =>
                startChannelInternal(plugin.id, undefined, {
                  ...startOptions,
                  ...(deferAccountStartUntil ? { deferAccountStartUntil } : {}),
                }),
              );
            } catch (err) {
              ensureChannelLog(plugin.id).error?.(
                `[${plugin.id}] channel startup failed: ${formatErrorMessage(err)}`,
              );
            }
          },
        ),
      });
    } finally {
      releaseAccountStarts?.();
    }
  };

  const startChannels = async () => await startChannelsWithOptions();

  const recoverAutostartSuppression = async (): Promise<boolean> => {
    if (
      !autostartSuppression ||
      opts.isClosing?.() ||
      !opts.tryRecoverAutostartSuppression?.() ||
      opts.isClosing?.()
    ) {
      return false;
    }
    autostartSuppression = null;
    // Recovery resumes the autostart attempt that safe mode deferred. Preserve
    // explicit operator stops while still covering health-monitor opt-outs.
    await startChannelsWithOptions({ preserveManualStop: true });
    return true;
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
    setStoppedRuntime(channelId, resolvedId, {
      ...(cleared ? { linked: false } : {}),
      restartPending: false,
      lastError: cleared ? "logged out" : current.lastError,
    });
  };

  const getRuntimeSnapshot = (): ChannelRuntimeSnapshot => {
    const registry = getPluginRegistry();
    const cfg = getRuntimeConfig();
    const channels: ChannelRuntimeSnapshot["channels"] = {};
    const channelAccounts: ChannelRuntimeSnapshot["channelAccounts"] = {};
    for (const plugin of listLoadedChannelPluginsForRegistry(registry)) {
      const store = getStore(plugin.id);
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accounts: Record<string, ChannelAccountSnapshot> = {};
      for (const id of accountIds) {
        const current = store.runtimes.get(id) ?? cloneDefaultRuntime(plugin.id, id);
        const unavailable = resolveUnavailableChannelAccountSnapshot(cfg, {
          registry,
          channelId: plugin.id,
          accountId: id,
          runtime: current,
        });
        if (unavailable) {
          accounts[id] = unavailable;
          continue;
        }
        const inspected = plugin.config.inspectAccount?.(cfg, id);
        if (inspected) {
          accounts[id] = buildChannelAccountSnapshotFromInspection({
            account: inspected,
            accountId: id,
            runtime: current,
          });
          continue;
        }
        const account = plugin.config.resolveAccount(cfg, id);
        const enabled = plugin.config.isEnabled
          ? plugin.config.isEnabled(account, cfg)
          : isAccountEnabled(account);
        const described = plugin.config.describeAccount?.(account, cfg);
        const configured = described?.configured ?? current.configured ?? true;
        const state = resolveChannelAccountState({
          enabled,
          configured,
          linked: plugin.config.isLinked
            ? current.linked
            : typeof current.linked === "boolean"
              ? current.linked
              : described?.linked,
          runtime: current,
          disabledReason: plugin.config.disabledReason?.(account, cfg),
          unconfiguredReason: plugin.config.unconfiguredReason?.(account, cfg),
          unlinkedReason: plugin.config.unlinkedReason?.(account, cfg),
        });
        const next = { ...current, accountId: id, enabled };
        applyChannelAccountState(next, state);
        if (described?.mode !== undefined) {
          next.mode = described.mode;
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

  const isAutoRestartScheduled = (channelId: ChannelId, accountId: string): boolean => {
    return pendingAutoRestarts.has(restartKey(channelId, accountId));
  };

  const resetRestartAttempts = (channelId: ChannelId, accountId: string): void => {
    restarts.delete(restartKey(channelId, accountId));
  };

  return {
    getRuntimeSnapshot,
    pauseChannelStarts: () => {
      const previous = channelStartPause;
      const release: ReturnType<ChannelManager["pauseChannelStarts"]> = (outcome) => {
        // Failed replacement can retain a fence; a cancelled retry must restore it.
        if (channelStartPause === release) {
          channelStartPause = outcome === "published" ? undefined : previous;
        }
      };
      channelStartPause = release;
      return release;
    },
    startChannels,
    startChannel: startChannelInternal,
    stopChannel,
    pruneInactiveChannelAccountState,
    setAutostartSuppression: (suppression) => {
      autostartSuppression = suppression;
    },
    getAutostartSuppression: () => autostartSuppression,
    recoverAutostartSuppression,
    setAmbientAutostartSuppressedChannelIds: (channelIds) => {
      ambientAutostartSuppressedChannelIds = new Set(channelIds);
    },
    isAmbientAutostartSuppressed: (channelId) =>
      ambientAutostartSuppressedChannelIds.has(channelId),
    markChannelLoggedOut,
    isManuallyStopped: isManuallyStoppedFlag,
    resolveRuntimeAccountId: (channelId, accountId) => {
      const matches = [...(channelStores.get(channelId)?.runtimes.keys() ?? [])].filter(
        (id) => normalizeAccountId(id) === accountId,
      );
      return matches.length === 1 ? matches[0] : undefined;
    },
    isAutoRestartScheduled,
    resetRestartAttempts,
    isHealthMonitorEnabled,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

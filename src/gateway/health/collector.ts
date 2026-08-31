import { expectDefined } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../../agents/agent-scope.js";
import { redactChannelStatusSummaryBaseUrl } from "../../channels/account-snapshot-fields.js";
import { buildChannelAccountSnapshotFromInspection } from "../../channels/account-summary.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { buildChannelAccountSnapshotFromAccount } from "../../channels/plugins/status.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { resolveUnavailableChannelAccountSnapshot } from "../../channels/status/account-state.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { SessionEntrySummary } from "../../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveHeartbeatSummaryForAgent } from "../../infra/heartbeat-summary.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import {
  degradedPluginMatchesRoot,
  listActiveDegradedPlugins,
  toPublicPluginVerificationDiagnostic,
} from "../../plugins/runtime-degraded-state.js";
import { getActivePluginRegistry } from "../../plugins/runtime.js";
import { listPluginServiceHealthFailures } from "../../plugins/service-health.js";
import { buildChannelAccountBindings, resolvePreferredAccountId } from "../../routing/bindings.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../../utils/absolute-deadline.js";
import { runTasksWithConcurrency } from "../../utils/run-with-concurrency.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  resolveChannelHealthState,
} from "../channel-health-policy.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { buildNonSensitiveProbeFailure, resolveHealthAccountContext } from "./account-context.js";
import { buildContextEngineHealthSummary } from "./context-engine.js";
import { buildDeliveryQueueHealthSummary } from "./delivery-queue.js";
import type {
  AgentHealthSummary,
  ChannelAccountHealthSummary,
  ChannelHealthSummary,
  HealthSummary,
  PluginHealthErrorSummary,
  PluginHealthSummary,
} from "./types.js";

// `status --all` gives live health 8s, so the Gateway must finish first.
const HEALTH_COLLECTION_TIMEOUT_MS = 7_000;
const HEALTH_PROBE_CONCURRENCY = 5;
const HEALTH_RECENT_SESSION_LIMIT = 5;
const healthLog = createSubsystemLogger("health");

type HealthSnapshotAudience = "public" | "admin";

const debugHealth = (
  cfg: OpenClawConfig | undefined,
  message: string,
  meta?: Record<string, unknown>,
) => {
  if (isDiagnosticFlagEnabled("health", cfg)) {
    healthLog.info(message, meta);
  }
};

const resolveHeartbeatSummary = (cfg: OpenClawConfig, agentId: string) =>
  resolveHeartbeatSummaryForAgent(cfg, agentId);

function attachPluginActivation(
  plugin: NonNullable<ReturnType<typeof getActivePluginRegistry>>["plugins"][number] | undefined,
  error: PluginHealthErrorSummary,
): PluginHealthErrorSummary {
  if (plugin?.activationSource) {
    error.activationSource = plugin.activationSource;
  }
  if (plugin?.activationReason) {
    error.activationReason = plugin.activationReason;
  }
  return error;
}

export function resolveHealthAgentOrder(cfg: OpenClawConfig) {
  const defaultAgentId = tryResolveLegacyCompatibilityAgentId(cfg);
  const entries = listAgentEntries(cfg);
  const seen = new Set<string>();
  const ordered: Array<{ id: string; name?: string }> = [];

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if (typeof entry.id !== "string" || !entry.id.trim()) {
      continue;
    }
    const id = normalizeAgentId(entry.id);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    ordered.push({ id, name: typeof entry.name === "string" ? entry.name : undefined });
  }

  if (defaultAgentId && !seen.has(defaultAgentId)) {
    ordered.unshift({ id: defaultAgentId });
  }

  return { defaultAgentId, ordered };
}

async function createHealthSessionStoreReader() {
  const { createStatusSessionStoreReader } = await import("../../status/session-stores.js");
  const { listSessionEntriesReadOnly } = await import("../../config/sessions/session-accessor.js");
  const { isTransientSqliteError } = await import("../../infra/unhandled-rejections.js");
  return createStatusSessionStoreReader((scope) => {
    try {
      return listSessionEntriesReadOnly({ ...scope, clone: false, projection: "list" });
    } catch (error) {
      if (!isTransientSqliteError(error)) {
        throw error;
      }
      // Health is best-effort: one empty snapshot beats repeated transient lock failures.
      return [];
    }
  });
}

function projectHealthSessions(path: string, sessions: SessionEntrySummary[]) {
  const recentSessions: Array<{ key: string; updatedAt: number }> = [];
  for (const { sessionKey: key, entry } of sessions) {
    const session = { key, updatedAt: entry.updatedAt ?? 0 };
    const insertAt = recentSessions.findIndex(
      (recentSession) => session.updatedAt > recentSession.updatedAt,
    );
    // Health returns only five rows. Keep the projection bounded while scanning
    // so refreshes never sort the complete session snapshot.
    if (insertAt >= 0) {
      recentSessions.splice(insertAt, 0, session);
      if (recentSessions.length > HEALTH_RECENT_SESSION_LIMIT) {
        recentSessions.pop();
      }
    } else if (recentSessions.length < HEALTH_RECENT_SESSION_LIMIT) {
      recentSessions.push(session);
    }
  }
  const recent = recentSessions.map((session) => ({
    key: session.key,
    updatedAt: session.updatedAt || null,
    age: session.updatedAt ? Date.now() - session.updatedAt : null,
  }));
  return {
    path,
    count: sessions.length,
    recent,
  } satisfies HealthSummary["sessions"];
}

async function buildHealthSessionSummary(storePath: string, agentId?: string) {
  const reader = await createHealthSessionStoreReader();
  const store = reader.read(storePath, agentId);
  return projectHealthSessions(store.path, store.sessions);
}

/** Projects borrowed rows synchronously before returning the owned health summaries. */
export async function buildHealthAgentSummaries(
  cfg: OpenClawConfig,
  { defaultAgentId, ordered }: ReturnType<typeof resolveHealthAgentOrder>,
): Promise<AgentHealthSummary[]> {
  const reader = await createHealthSessionStoreReader();
  return ordered.map((entry) => {
    const store = reader.read(
      resolveSessionStorePathCore(cfg.session?.store, { agentId: entry.id }),
      entry.id,
    );
    return {
      agentId: entry.id,
      name: entry.name,
      isDefault: entry.id === defaultAgentId,
      heartbeat: resolveHeartbeatSummary(cfg, entry.id),
      sessions: projectHealthSessions(store.path, store.sessions),
    };
  });
}

function buildPluginHealthSummary(): PluginHealthSummary | undefined {
  const registry = getActivePluginRegistry();
  const degradedPlugins = listActiveDegradedPlugins();
  const unavailable = degradedPlugins
    .map(({ pluginId, state, diagnostic }) => ({
      id: pluginId,
      state,
      diagnostic: toPublicPluginVerificationDiagnostic(diagnostic),
    }))
    .toSorted((left, right) => left.id.localeCompare(right.id));
  const loaded = (registry?.plugins ?? [])
    .filter((plugin) => plugin.status === "loaded")
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  const loadErrors = (registry?.plugins ?? [])
    .filter(
      (plugin) =>
        plugin.status === "error" &&
        !degradedPlugins.some(
          (degraded) =>
            plugin.id === degraded.pluginId &&
            plugin.failurePhase === "validation" &&
            plugin.activationReason === `configured-unavailable: ${degraded.diagnostic.reason}` &&
            Boolean(plugin.rootDir) &&
            degradedPluginMatchesRoot(degraded, plugin.rootDir ?? ""),
        ),
    )
    .map((plugin) =>
      attachPluginActivation(plugin, {
        id: plugin.id,
        origin: plugin.origin,
        activated: plugin.activated === true,
        error: plugin.error ?? "unknown plugin load error",
        ...(plugin.failurePhase ? { failurePhase: plugin.failurePhase } : {}),
      }),
    );
  const serviceErrors = registry
    ? listPluginServiceHealthFailures(registry).map((failure) =>
        attachPluginActivation(
          registry.plugins.find((entry) => entry.id === failure.pluginId),
          {
            id: failure.pluginId,
            origin: failure.origin,
            // Starting the registered service is the authoritative activation fact.
            activated: true,
            failurePhase: "service",
            error: `service ${failure.serviceId}: ${failure.error}`,
          },
        ),
      )
    : [];
  const errors = [...loadErrors, ...serviceErrors].toSorted(
    (left, right) => left.id.localeCompare(right.id) || left.error.localeCompare(right.error),
  );
  if (loaded.length === 0 && errors.length === 0 && unavailable.length === 0) {
    return undefined;
  }
  return { loaded, errors, unavailable };
}

type HealthChannelPlan = {
  plugin: ChannelPlugin;
  defaultAccountId: string;
  preferredAccountId: string;
  accountIds: string[];
  accountSummaries: Record<string, ChannelAccountHealthSummary>;
};

type HealthOperationRelease = () => void;
type HealthOperationWaiter = {
  deadlineAtMs: number;
  resolve: (release: HealthOperationRelease | null) => void;
  timer: ReturnType<typeof setTimeout>;
  settled: boolean;
};

// Permits outlive response deadlines so an unfinished plugin hook cannot be
// replaced by later health refreshes and amplify process-wide probe work.
let activeHealthOperations = 0;
const healthOperationWaiters: HealthOperationWaiter[] = [];

function settleHealthOperationWaiter(
  waiter: HealthOperationWaiter,
  release: HealthOperationRelease | null,
): void {
  if (waiter.settled) {
    return;
  }
  waiter.settled = true;
  clearTimeout(waiter.timer);
  waiter.resolve(release);
}

function releaseNextHealthOperationWaiter(): void {
  while (healthOperationWaiters.length > 0) {
    const waiter = healthOperationWaiters.shift();
    if (!waiter || waiter.settled) {
      continue;
    }
    if (Date.now() >= waiter.deadlineAtMs) {
      settleHealthOperationWaiter(waiter, null);
      continue;
    }
    settleHealthOperationWaiter(waiter, createHealthOperationRelease());
    return;
  }
}

function createHealthOperationRelease(): HealthOperationRelease {
  activeHealthOperations += 1;
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    activeHealthOperations -= 1;
    releaseNextHealthOperationWaiter();
  };
}

async function acquireHealthOperationPermit(
  deadlineAtMs: number,
): Promise<HealthOperationRelease | null> {
  if (Date.now() >= deadlineAtMs) {
    return null;
  }
  if (activeHealthOperations < HEALTH_PROBE_CONCURRENCY) {
    return createHealthOperationRelease();
  }

  return await new Promise<HealthOperationRelease | null>((resolve) => {
    const waiter: HealthOperationWaiter = {
      deadlineAtMs,
      resolve,
      timer: setTimeout(
        () => {
          const index = healthOperationWaiters.indexOf(waiter);
          if (index >= 0) {
            healthOperationWaiters.splice(index, 1);
          }
          settleHealthOperationWaiter(waiter, null);
        },
        Math.max(1, deadlineAtMs - Date.now()),
      ),
      settled: false,
    };
    if (typeof waiter.timer === "object" && "unref" in waiter.timer) {
      waiter.timer.unref();
    }
    healthOperationWaiters.push(waiter);
  });
}

function buildHealthTimeoutRecord(
  accountId: string,
  timeoutMs: number,
): ChannelAccountHealthSummary {
  const error = `health collection timed out after ${timeoutMs}ms`;
  return {
    accountId,
    lastError: error,
    probe: { ok: false, timedOut: true, error },
  };
}

function resolveHealthProbeTimeoutMs(deadlineAtMs: number): number {
  return Math.max(1, deadlineAtMs - Date.now());
}

async function buildHealthAccountRecord(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  defaultAccountId: string;
  includeSensitive: boolean;
  probe: boolean;
  deadlineAtMs: number;
  timeoutMs: number;
  runtimeSnapshot?: ChannelRuntimeSnapshot;
}): Promise<ChannelAccountHealthSummary> {
  const timedOut = () => buildHealthTimeoutRecord(params.accountId, params.timeoutMs);
  const runtimeSnapshot =
    params.runtimeSnapshot?.channelAccounts[params.plugin.id]?.[params.accountId] ??
    (params.accountId === params.defaultAccountId
      ? params.runtimeSnapshot?.channels[params.plugin.id]
      : undefined);
  const unavailable = resolveUnavailableChannelAccountSnapshot({
    channelId: params.plugin.id,
    accountId: params.accountId,
    runtime: runtimeSnapshot,
  });
  if (unavailable) {
    return unavailable;
  }
  const { probeAccount, inspectedAccount, enabled, configured, diagnostics } =
    await resolveHealthAccountContext({
      plugin: params.plugin,
      cfg: params.cfg,
      accountId: params.accountId,
    });
  if (Date.now() >= params.deadlineAtMs) {
    return timedOut();
  }
  if (diagnostics.length > 0) {
    debugHealth(params.cfg, "account.diagnostics", {
      channel: params.plugin.id,
      accountId: params.accountId,
      diagnostics,
    });
  }

  let probe: unknown;
  let lastProbeAt: number | null = null;
  if (
    probeAccount !== undefined &&
    enabled &&
    configured === true &&
    params.probe &&
    params.plugin.status?.probeAccount
  ) {
    try {
      probe = await params.plugin.status.probeAccount({
        account: probeAccount,
        timeoutMs: resolveHealthProbeTimeoutMs(params.deadlineAtMs),
        cfg: params.cfg,
      });
      lastProbeAt = Date.now();
    } catch (error) {
      probe = { ok: false, error: formatErrorMessage(error) };
      lastProbeAt = Date.now();
    }
  }
  if (Date.now() >= params.deadlineAtMs) {
    return timedOut();
  }

  const probeRecord =
    probe && typeof probe === "object" ? (probe as Record<string, unknown>) : null;
  const bot =
    probeRecord && typeof probeRecord.bot === "object"
      ? (probeRecord.bot as { username?: string | null })
      : null;
  if (bot?.username) {
    debugHealth(params.cfg, "probe.bot", {
      channel: params.plugin.id,
      accountId: params.accountId,
      username: bot.username,
    });
  }

  const nonSensitiveProbeFailure = buildNonSensitiveProbeFailure(params.plugin.id, probe);
  const snapshotProbe = params.includeSensitive ? probe : nonSensitiveProbeFailure;
  const snapshot: ChannelAccountSnapshot =
    probeAccount === undefined
      ? buildChannelAccountSnapshotFromInspection({
          account: inspectedAccount,
          accountId: params.accountId,
          runtime: runtimeSnapshot,
          probe: snapshotProbe,
        })
      : await buildChannelAccountSnapshotFromAccount({
          plugin: params.plugin,
          cfg: params.cfg,
          accountId: params.accountId,
          account: probeAccount,
          runtime: runtimeSnapshot,
          probe: snapshotProbe,
          enabledFallback: enabled,
          configuredFallback: configured,
        });
  if (Date.now() >= params.deadlineAtMs) {
    return timedOut();
  }
  if (lastProbeAt) {
    snapshot.lastProbeAt = lastProbeAt;
  }
  const healthState = resolveChannelHealthState(snapshot, {
    channelId: params.plugin.id,
    now: Date.now(),
    staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
    channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  });
  if (healthState !== undefined) {
    snapshot.healthState = healthState;
  }

  const summary =
    probeAccount !== undefined && params.plugin.status?.buildChannelSummary
      ? await params.plugin.status.buildChannelSummary({
          account: probeAccount,
          cfg: params.cfg,
          defaultAccountId: params.accountId,
          snapshot,
        })
      : undefined;
  if (Date.now() >= params.deadlineAtMs) {
    return timedOut();
  }
  // Summary hooks overlay the safe snapshot, so reapply URL redaction after the final merge.
  const record = redactChannelStatusSummaryBaseUrl(
    summary && typeof summary === "object"
      ? ({ ...snapshot, ...summary } as ChannelAccountHealthSummary)
      : ({
          ...snapshot,
          accountId: params.accountId,
        } satisfies ChannelAccountHealthSummary),
  );
  if (record.configured === undefined && probeAccount !== undefined) {
    record.configured = configured;
  }
  if (params.includeSensitive && record.probe === undefined && probe !== undefined) {
    record.probe = probe;
  }
  if (!params.includeSensitive) {
    const summaryProbeFailure = buildNonSensitiveProbeFailure(params.plugin.id, record.probe);
    const safeProbeFailure = summaryProbeFailure ?? nonSensitiveProbeFailure;
    if (safeProbeFailure) {
      record.probe = safeProbeFailure;
    } else {
      delete record.probe;
    }
  }
  if (record.lastProbeAt === undefined && lastProbeAt) {
    record.lastProbeAt = lastProbeAt;
  }
  record.accountId = params.accountId;
  return record;
}

async function runHealthAccountWithinDeadline(
  params: Parameters<typeof buildHealthAccountRecord>[0],
): Promise<ChannelAccountHealthSummary> {
  const release = await acquireHealthOperationPermit(params.deadlineAtMs);
  if (!release) {
    return buildHealthTimeoutRecord(params.accountId, params.timeoutMs);
  }

  const operation = buildHealthAccountRecord(params);
  void operation.then(release, release);
  const result = await awaitWithinDeadline(() => operation, params.deadlineAtMs);
  return result === ABSOLUTE_DEADLINE_EXPIRED
    ? buildHealthTimeoutRecord(params.accountId, params.timeoutMs)
    : result;
}

/** Collects the gateway-owned health snapshot for an explicit trust audience. */
export async function collectGatewayHealthSnapshot(params: {
  audience: HealthSnapshotAudience;
  probe: boolean;
  timeoutMs?: number;
  runtimeSnapshot?: ChannelRuntimeSnapshot;
  eventLoop?: HealthSummary["eventLoop"];
  configReloadHotReloadStatus?: GatewayHotReloadStatus;
}): Promise<HealthSummary> {
  const start = Date.now();
  const timeoutMs = Math.min(
    resolveTimerTimeoutMs(params.timeoutMs, HEALTH_COLLECTION_TIMEOUT_MS, 50),
    HEALTH_COLLECTION_TIMEOUT_MS,
  );
  const deadlineAtMs = start + timeoutMs;
  const cfg = await readRuntimeHealthConfig();
  const { defaultAgentId, ordered } = resolveHealthAgentOrder(cfg);
  const channelBindings = buildChannelAccountBindings(cfg);
  const agents = await buildHealthAgentSummaries(cfg, { defaultAgentId, ordered });
  const summaryAgent = agents.find((agent) => agent.isDefault) ?? agents[0];
  const configuredHeartbeatAgentId = normalizeOptionalString(
    cfg.agents?.defaults?.heartbeat?.agentId,
  );
  const heartbeatSummaryAgent =
    (configuredHeartbeatAgentId
      ? agents.find(
          (agent) =>
            agent.heartbeat.enabled &&
            agent.agentId === normalizeAgentId(configuredHeartbeatAgentId),
        )
      : undefined) ??
    agents.find((agent) => agent.heartbeat.enabled) ??
    summaryAgent;
  const heartbeatSeconds = heartbeatSummaryAgent?.heartbeat.everyMs
    ? Math.round(heartbeatSummaryAgent.heartbeat.everyMs / 1000)
    : 0;
  const sessions =
    summaryAgent?.sessions ??
    (await buildHealthSessionSummary(
      resolveSessionStorePathCore(cfg.session?.store, { agentId: summaryAgent?.agentId }),
      summaryAgent?.agentId,
    ));

  const includeSensitive = params.audience === "admin";
  const channels: Record<string, ChannelHealthSummary> = {};
  const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupFallbackPlugins: false,
  });
  const channelOrder = plugins.map((plugin) => plugin.id);
  const channelLabels: Record<string, string> = {};
  const channelPlans: HealthChannelPlan[] = plugins.map((plugin) => {
    channelLabels[plugin.id] = plugin.meta.label ?? plugin.id;
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds,
    });
    const boundAccounts = defaultAgentId
      ? (channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [])
      : [];
    const preferredAccountId = resolvePreferredAccountId({
      accountIds,
      defaultAccountId,
      boundAccounts,
    });
    const boundAccountIdsAll = Array.from(
      new Set(Array.from(channelBindings.get(plugin.id)?.values() ?? []).flat()),
    );
    const accountIdsToProbe = Array.from(
      new Set(
        [preferredAccountId, defaultAccountId, ...accountIds, ...boundAccountIdsAll].filter(
          (value) => value && value.trim(),
        ),
      ),
    );
    // Probe preferred/default/bound accounts first, but include all configured
    // accounts so verbose health can explain account-specific failures.
    debugHealth(cfg, "channel", {
      id: plugin.id,
      accountIds,
      defaultAccountId,
      boundAccounts,
      preferredAccountId,
      accountIdsToProbe,
    });
    return {
      plugin,
      defaultAccountId,
      preferredAccountId,
      accountIds: accountIdsToProbe,
      accountSummaries: {},
    };
  });
  const accountTasks = channelPlans.flatMap((plan) =>
    plan.accountIds.map((accountId) => ({ plan, accountId })),
  );
  const { results: accountResults } = await runTasksWithConcurrency({
    tasks: accountTasks.map(({ plan, accountId }) => async () => ({
      plan,
      accountId,
      record: await runHealthAccountWithinDeadline({
        plugin: plan.plugin,
        cfg,
        accountId,
        defaultAccountId: plan.defaultAccountId,
        includeSensitive,
        probe: params.probe,
        deadlineAtMs,
        timeoutMs,
        runtimeSnapshot: params.runtimeSnapshot,
      }),
    })),
    limit: params.probe ? HEALTH_PROBE_CONCURRENCY : 1,
    throwOnError: true,
  });
  for (const result of accountResults) {
    if (result) {
      result.plan.accountSummaries[result.accountId] = result.record;
    }
  }

  for (const plan of channelPlans) {
    const defaultSummary =
      plan.accountSummaries[plan.preferredAccountId] ??
      plan.accountSummaries[plan.defaultAccountId] ??
      plan.accountSummaries[plan.accountIds[0] ?? plan.preferredAccountId];
    const fallbackSummary =
      defaultSummary ??
      plan.accountSummaries[
        expectDefined(
          Object.keys(plan.accountSummaries)[0],
          "object.keys(account summaries) entry at 0",
        )
      ];
    if (fallbackSummary) {
      channels[plan.plugin.id] = {
        ...fallbackSummary,
        accounts: plan.accountSummaries,
      } satisfies ChannelHealthSummary;
    }
  }

  const pluginHealth = buildPluginHealthSummary();
  const contextEngineHealth = buildContextEngineHealthSummary();
  const deliveryQueueHealth = buildDeliveryQueueHealthSummary();
  return {
    ok: true,
    ts: Date.now(),
    durationMs: Date.now() - start,
    ...(params.eventLoop ? { eventLoop: params.eventLoop } : {}),
    ...(pluginHealth ? { plugins: pluginHealth } : {}),
    ...(contextEngineHealth ? { contextEngines: contextEngineHealth } : {}),
    ...(deliveryQueueHealth ? { deliveryQueues: deliveryQueueHealth } : {}),
    ...(params.configReloadHotReloadStatus
      ? { configReload: { hotReloadStatus: params.configReloadHotReloadStatus } }
      : {}),
    channels,
    channelOrder,
    channelLabels,
    heartbeatSeconds,
    ...(defaultAgentId ? { defaultAgentId } : {}),
    agents,
    sessions: {
      path: sessions.path,
      count: sessions.count,
      recent: sessions.recent,
    },
  };
}

async function readRuntimeHealthConfig(): Promise<OpenClawConfig> {
  const { getRuntimeConfig } = await import("../../config/config.js");
  return getRuntimeConfig();
}

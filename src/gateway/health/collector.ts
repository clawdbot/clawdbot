import { expectDefined } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { listAgentEntries } from "../../agents/agent-scope.js";
import { redactChannelStatusSummaryBaseUrl } from "../../channels/account-snapshot-fields.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { buildChannelAccountSnapshotFromAccount } from "../../channels/plugins/status.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "../../config/sessions/session-sqlite-target.js";
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

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
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
  if (ordered.length === 0 && defaultAgentId) {
    ordered.push({ id: defaultAgentId });
  }

  return { defaultAgentId, ordered };
}

export async function buildHealthSessionSummary(storePath: string, agentId?: string) {
  const databasePath = resolveSqliteTargetFromSessionStorePath(storePath, { agentId }).path;
  const { listSessionEntriesReadOnly } = await import("../../config/sessions/session-accessor.js");
  const { isTransientSqliteError } = await import("../../infra/unhandled-rejections.js");
  let listed: ReturnType<typeof listSessionEntriesReadOnly>;
  try {
    listed = listSessionEntriesReadOnly({
      ...(agentId ? { agentId } : {}),
      clone: false,
      projection: "list",
      storePath,
    });
  } catch (error) {
    if (!isTransientSqliteError(error)) {
      throw error;
    }
    // Health is best-effort: an empty snapshot beats failing on a transient lock.
    listed = [];
  }
  const recentSessions: Array<{ key: string; updatedAt: number }> = [];
  let sessionCount = 0;
  for (const { sessionKey, entry } of listed) {
    if (sessionKey === "global" || sessionKey === "unknown") {
      continue;
    }
    sessionCount += 1;
    const session = { key: sessionKey, updatedAt: entry?.updatedAt ?? 0 };
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
    path: databasePath,
    count: sessionCount,
    recent,
  } satisfies HealthSummary["sessions"];
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

/** Collects the gateway-owned health snapshot for an explicit trust audience. */
export async function collectGatewayHealthSnapshot(params: {
  audience: HealthSnapshotAudience;
  probe: boolean;
  timeoutMs?: number;
  runtimeSnapshot?: ChannelRuntimeSnapshot;
  eventLoop?: HealthSummary["eventLoop"];
  configReloadHotReloadStatus?: GatewayHotReloadStatus;
}): Promise<HealthSummary> {
  const cfg = await readRuntimeHealthConfig();
  const { defaultAgentId, ordered } = resolveHealthAgentOrder(cfg);
  const channelBindings = buildChannelAccountBindings(cfg);
  const sessionCache = new Map<string, HealthSummary["sessions"]>();
  const agents: AgentHealthSummary[] = [];
  for (const entry of ordered) {
    const storePath = resolveSessionStorePathCore(cfg.session?.store, { agentId: entry.id });
    const sessionCacheKey = `${storePath}\0${entry.id}`;
    const sessions =
      sessionCache.get(sessionCacheKey) ?? (await buildHealthSessionSummary(storePath, entry.id));
    sessionCache.set(sessionCacheKey, sessions);
    agents.push({
      agentId: entry.id,
      name: entry.name,
      isDefault: entry.id === defaultAgentId,
      heartbeat: resolveHeartbeatSummary(cfg, entry.id),
      sessions,
    });
  }
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

  const start = Date.now();
  const cappedTimeout = resolveTimerTimeoutMs(params.timeoutMs, DEFAULT_HEALTH_TIMEOUT_MS, 50);
  const includeSensitive = params.audience === "admin";
  const channels: Record<string, ChannelHealthSummary> = {};
  const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupFallbackPlugins: false,
  });
  const channelOrder = plugins.map((plugin) => plugin.id);
  const channelLabels: Record<string, string> = {};

  for (const plugin of plugins) {
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
    const accountSummaries: Record<string, ChannelAccountHealthSummary> = {};

    for (const accountId of accountIdsToProbe) {
      const { probeAccount, snapshotAccount, enabled, configured, diagnostics } =
        await resolveHealthAccountContext({
          plugin,
          cfg,
          accountId,
        });
      if (diagnostics.length > 0) {
        debugHealth(cfg, "account.diagnostics", { channel: plugin.id, accountId, diagnostics });
      }

      let probe: unknown;
      let lastProbeAt: number | null = null;
      if (enabled && configured && params.probe && plugin.status?.probeAccount) {
        try {
          probe = await plugin.status.probeAccount({
            account: probeAccount,
            timeoutMs: cappedTimeout,
            cfg,
          });
          lastProbeAt = Date.now();
        } catch (error) {
          probe = { ok: false, error: formatErrorMessage(error) };
          lastProbeAt = Date.now();
        }
      }

      const probeRecord =
        probe && typeof probe === "object" ? (probe as Record<string, unknown>) : null;
      const bot =
        probeRecord && typeof probeRecord.bot === "object"
          ? (probeRecord.bot as { username?: string | null })
          : null;
      if (bot?.username) {
        debugHealth(cfg, "probe.bot", { channel: plugin.id, accountId, username: bot.username });
      }

      const runtimeSnapshot =
        params.runtimeSnapshot?.channelAccounts[plugin.id]?.[accountId] ??
        (accountId === defaultAccountId ? params.runtimeSnapshot?.channels[plugin.id] : undefined);
      const nonSensitiveProbeFailure = buildNonSensitiveProbeFailure(plugin.id, probe);
      const snapshotProbe = includeSensitive ? probe : nonSensitiveProbeFailure;
      const snapshot: ChannelAccountSnapshot = await buildChannelAccountSnapshotFromAccount({
        plugin,
        cfg,
        accountId,
        account: snapshotAccount,
        runtime: runtimeSnapshot,
        probe: snapshotProbe,
        enabledFallback: enabled,
        configuredFallback: configured,
      });
      if (lastProbeAt) {
        snapshot.lastProbeAt = lastProbeAt;
      }
      const healthState = resolveChannelHealthState(snapshot, {
        channelId: plugin.id,
        now: Date.now(),
        staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
        channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
      });
      if (healthState !== undefined) {
        snapshot.healthState = healthState;
      }

      const summary = plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account: probeAccount,
            cfg,
            defaultAccountId: accountId,
            snapshot,
          })
        : undefined;
      // Summary hooks overlay the safe snapshot, so reapply URL redaction after the final merge.
      const record = redactChannelStatusSummaryBaseUrl(
        summary && typeof summary === "object"
          ? ({ ...snapshot, ...summary } as ChannelAccountHealthSummary)
          : ({ ...snapshot, accountId, configured } satisfies ChannelAccountHealthSummary),
      );
      if (record.configured === undefined) {
        record.configured = configured;
      }
      if (includeSensitive && record.probe === undefined && probe !== undefined) {
        record.probe = probe;
      }
      if (!includeSensitive) {
        const summaryProbeFailure = buildNonSensitiveProbeFailure(plugin.id, record.probe);
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
      record.accountId = accountId;
      accountSummaries[accountId] = record;
    }

    const defaultSummary =
      accountSummaries[preferredAccountId] ??
      accountSummaries[defaultAccountId] ??
      accountSummaries[accountIdsToProbe[0] ?? preferredAccountId];
    const fallbackSummary =
      defaultSummary ??
      accountSummaries[
        expectDefined(Object.keys(accountSummaries)[0], "object.keys(account summaries) entry at 0")
      ];
    if (fallbackSummary) {
      channels[plugin.id] = {
        ...fallbackSummary,
        accounts: accountSummaries,
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

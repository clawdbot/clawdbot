import { expectDefined } from "@openclaw/normalization-core";
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { listAgentEntries, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { redactChannelStatusSummaryBaseUrl } from "../../channels/account-snapshot-fields.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { buildChannelAccountSnapshotFromAccount } from "../../channels/plugins/status.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import { resolveStorePath } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listContextEngineQuarantines } from "../../context-engine/registry.js";
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
import { buildChannelAccountBindings, resolvePreferredAccountId } from "../../routing/bindings.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
  resolveChannelHealthState,
} from "../channel-health-policy.js";
import type { GatewayHotReloadStatus } from "../config-reload-status.types.js";
import type { ChannelRuntimeSnapshot } from "../server-channel-runtime.types.js";
import { buildNonSensitiveProbeFailure, resolveHealthAccountContext } from "./account-context.js";
import { buildDeliveryQueueHealthSummary } from "./delivery-queue.js";
import type {
  AgentHealthSummary,
  ChannelAccountHealthSummary,
  ChannelHealthSummary,
  ContextEngineHealthSummary,
  HealthSummary,
  PluginHealthErrorSummary,
  PluginHealthSummary,
} from "./types.js";

const DEFAULT_HEALTH_TIMEOUT_MS = 10_000;
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

function buildContextEngineHealthSummary(): ContextEngineHealthSummary | undefined {
  const quarantined: ContextEngineHealthSummary["quarantined"] = [];
  for (const entry of listContextEngineQuarantines()) {
    const summary: ContextEngineHealthSummary["quarantined"][number] = {
      engineId: entry.engineId,
      operation: entry.operation,
      reason: entry.reason,
      failedAt: entry.failedAt.getTime(),
    };
    if (entry.owner) {
      summary.owner = entry.owner;
    }
    quarantined.push(summary);
  }
  return quarantined.length > 0 ? { quarantined } : undefined;
}

const resolveHeartbeatSummary = (cfg: OpenClawConfig, agentId: string) =>
  resolveHeartbeatSummaryForAgent(cfg, agentId);

export function resolveHealthAgentOrder(cfg: OpenClawConfig) {
  const defaultAgentId = resolveDefaultAgentId(cfg);
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

  if (!seen.has(defaultAgentId)) {
    ordered.unshift({ id: defaultAgentId });
  }
  if (ordered.length === 0) {
    ordered.push({ id: defaultAgentId });
  }

  return { defaultAgentId, ordered };
}

export async function buildHealthSessionSummary(storePath: string, agentId?: string) {
  const { listSessionEntriesReadOnly } = await import("../../config/sessions/session-accessor.js");
  const { isTransientSqliteError } = await import("../../infra/unhandled-rejections.js");
  let listed: ReturnType<typeof listSessionEntriesReadOnly>;
  try {
    listed = listSessionEntriesReadOnly({
      ...(agentId ? { agentId } : {}),
      storePath,
    });
  } catch (error) {
    if (!isTransientSqliteError(error)) {
      throw error;
    }
    // Health is best-effort: an empty snapshot beats failing on a transient lock.
    listed = [];
  }
  const sessions = listed
    .filter(({ sessionKey }) => sessionKey !== "global" && sessionKey !== "unknown")
    .map(({ sessionKey, entry }) => ({ key: sessionKey, updatedAt: entry?.updatedAt ?? 0 }))
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  const recent = sessions.slice(0, 5).map((session) => ({
    key: session.key,
    updatedAt: session.updatedAt || null,
    age: session.updatedAt ? Date.now() - session.updatedAt : null,
  }));
  return {
    path: storePath,
    count: sessions.length,
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
  const errors = (registry?.plugins ?? [])
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
    .map((plugin) => {
      const error: PluginHealthErrorSummary = {
        id: plugin.id,
        origin: plugin.origin,
        activated: plugin.activated === true,
        error: plugin.error ?? "unknown plugin load error",
      };
      if (plugin.activationSource) {
        error.activationSource = plugin.activationSource;
      }
      if (plugin.activationReason) {
        error.activationReason = plugin.activationReason;
      }
      if (plugin.failurePhase) {
        error.failurePhase = plugin.failurePhase;
      }
      return error;
    })
    .toSorted((left, right) => left.id.localeCompare(right.id));
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
    const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
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
  const defaultAgent = agents.find((agent) => agent.isDefault) ?? agents[0];
  const heartbeatSeconds = defaultAgent?.heartbeat.everyMs
    ? Math.round(defaultAgent.heartbeat.everyMs / 1000)
    : 0;
  const sessions =
    defaultAgent?.sessions ??
    (await buildHealthSessionSummary(
      resolveStorePath(cfg.session?.store, { agentId: defaultAgentId }),
      defaultAgentId,
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
    const boundAccounts = channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [];
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
      const health = evaluateChannelHealth(snapshot, {
        channelId: plugin.id,
        now: Date.now(),
        staleEventThresholdMs: DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
        channelConnectGraceMs: DEFAULT_CHANNEL_CONNECT_GRACE_MS,
      });
      const healthState = resolveChannelHealthState(snapshot, health);
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
    defaultAgentId,
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

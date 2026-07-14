import { expectDefined } from "@openclaw/normalization-core";
/** Collects and renders gateway health for channels, agents, plugins, and sessions. */
import { resolveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { styleHealthChannelLine } from "../../packages/terminal-core/src/health-style.js";
import { isRich } from "../../packages/terminal-core/src/theme.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { inspectChannelAccount } from "../channels/account-inspection.js";
import { redactChannelStatusSummaryBaseUrl } from "../channels/account-snapshot-fields.js";
import {
  resolveChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "../channels/account-summary.js";
import { countFailedChannelIngressQueueEntries } from "../channels/message/ingress-queue.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { buildChannelAccountSnapshotFromAccount } from "../channels/plugins/status.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import { probeGatewayStatus } from "../cli/daemon-cli/probe.js";
import { withProgress } from "../cli/progress.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listContextEngineQuarantines } from "../context-engine/registry.js";
import {
  buildGatewayConnectionDetails,
  buildGatewayProbeConnectionDetails,
  callGateway,
  formatGatewayTransportErrorJson,
  isGatewayCredentialsRequiredError,
} from "../gateway/call.js";
import {
  DEFAULT_CHANNEL_CONNECT_GRACE_MS,
  DEFAULT_CHANNEL_STALE_EVENT_THRESHOLD_MS,
  evaluateChannelHealth,
} from "../gateway/channel-health-policy.js";
import type { GatewayHotReloadStatus } from "../gateway/config-reload-status.types.js";
import { isGatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { getGatewayModelPricingHealth } from "../gateway/model-pricing-cache-state.js";
import { isGatewayModelPricingEnabled } from "../gateway/model-pricing-config.js";
import type { ChannelRuntimeSnapshot } from "../gateway/server-channel-runtime.types.js";
import { info } from "../globals.js";
import { countFailedDeliveryQueueEntries } from "../infra/delivery-queue-sqlite.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatDurationHuman } from "../infra/format-time/format-duration.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import {
  degradedPluginMatchesRoot,
  listActiveDegradedPlugins,
  toPublicPluginVerificationDiagnostic,
} from "../plugins/runtime-degraded-state.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import {
  buildRuntimeReadiness,
  buildUnobservedGatewayConditions,
} from "../readiness/conditions.js";
import { buildChannelAccountBindings, resolvePreferredAccountId } from "../routing/bindings.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  buildCredentialsRequiredHealthDiagnostic,
  GATEWAY_HEALTH_REACHABLE_LINE,
  gatewayProbeResultSawGateway,
} from "./gateway-health-auth-diagnostic.js";
import { formatHealthChannelLines } from "./health-format.js";
import type {
  AgentHealthSummary,
  ChannelAccountHealthSummary,
  ChannelHealthSummary,
  ContextEngineHealthSummary,
  DeliveryQueueHealthSummary,
  HealthSummary,
  PluginHealthErrorSummary,
  PluginHealthSummary,
} from "./health.types.js";
import { logGatewayConnectionDetails } from "./status.gateway-connection.js";
export { formatHealthChannelLines } from "./health-format.js";
export type { HealthSummary } from "./health.types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

const debugHealth = (cfg: OpenClawConfig | undefined, ...args: unknown[]) => {
  if (isDiagnosticFlagEnabled("health", cfg)) {
    console.warn("[health:debug]", ...args);
  }
};

function isGatewayHealthAuthUnavailableError(error: unknown): boolean {
  return isGatewayCredentialsRequiredError(error) || isGatewaySecretRefUnavailableError(error);
}

export async function emitReachableGatewayAuthDiagnostic(params: {
  error: unknown;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  timeoutMs?: number;
  token?: string;
  password?: string;
  localPortOverride?: number;
  json?: boolean;
}): Promise<boolean> {
  if (!isGatewayHealthAuthUnavailableError(params.error)) {
    return false;
  }
  const details = await buildGatewayProbeConnectionDetails({
    config: params.config,
    token: params.token,
    password: params.password,
    localPortOverride: params.localPortOverride,
  });
  const probe = await probeGatewayStatus({
    url: details.url,
    token: params.token,
    password: params.password,
    tlsFingerprint: details.tlsFingerprint,
    preauthHandshakeTimeoutMs: details.preauthHandshakeTimeoutMs,
    timeoutMs: params.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    config: params.config,
    json: params.json,
  });
  if (!gatewayProbeResultSawGateway(probe)) {
    return false;
  }
  const diagnostic = buildCredentialsRequiredHealthDiagnostic();
  if (params.json) {
    writeRuntimeJson(params.runtime, diagnostic);
    params.runtime.exit(1);
    return true;
  }
  params.runtime.log(GATEWAY_HEALTH_REACHABLE_LINE);
  params.runtime.log(diagnostic.error.message);
  params.runtime.exit(1);
  return true;
}

const loadConfigRuntime = async () => await import("../config/config.js");

const PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR =
  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";

const redactIMessageProbeErrorMessage = (message: string): string => {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replaceAll(
    /\/Users\/[^/\s]+\/Library\/Messages\/chat\.db/g,
    "~/Library/Messages/chat.db",
  );
};

const buildNonSensitiveProbeFailure = (
  channelId: string,
  probe: unknown,
): Record<string, unknown> | undefined => {
  const record = asNullableRecord(probe);
  if (channelId !== "imessage" || !record || record.ok !== false) {
    return undefined;
  }
  if (typeof record.error !== "string") {
    return undefined;
  }

  // Preserve the actionable Full Disk Access failure while stripping the local
  // username path before health leaves the gateway.
  const error = redactIMessageProbeErrorMessage(record.error);
  if (
    !/\bimsg\b/i.test(error) ||
    !error.includes("~/Library/Messages/chat.db") ||
    !/\bFull Disk Access\b/i.test(error)
  ) {
    return undefined;
  }
  return { ok: false, error: PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR };
};

const formatDurationParts = (ms: number): string => {
  if (!Number.isFinite(ms)) {
    return "unknown";
  }
  if (ms < 1000) {
    return `${Math.max(0, Math.round(ms))}ms`;
  }
  const units: Array<{ label: string; size: number }> = [
    { label: "w", size: 7 * 24 * 60 * 60 * 1000 },
    { label: "d", size: 24 * 60 * 60 * 1000 },
    { label: "h", size: 60 * 60 * 1000 },
    { label: "m", size: 60 * 1000 },
    { label: "s", size: 1000 },
  ];
  let remaining = Math.max(0, Math.floor(ms));
  const parts: string[] = [];
  for (const unit of units) {
    const value = Math.floor(remaining / unit.size);
    if (value > 0) {
      parts.push(`${value}${unit.label}`);
      remaining -= value * unit.size;
    }
  }
  if (parts.length === 0) {
    return "0s";
  }
  return parts.join(" ");
};

function formatEventLoopHealthLine(summary: HealthSummary): string | null {
  const eventLoop = summary.eventLoop;
  if (!eventLoop) {
    return null;
  }
  const state = eventLoop.degraded ? "degraded" : "ok";
  const reasons = eventLoop.reasons.length > 0 ? ` reasons=${eventLoop.reasons.join(",")}` : "";
  return `Gateway event loop: ${state}${reasons} max=${Math.round(
    eventLoop.delayMaxMs,
  )}ms p99=${Math.round(eventLoop.delayP99Ms)}ms util=${eventLoop.utilization} cpu=${
    eventLoop.cpuCoreRatio
  }`;
}

/** Formats optional model-pricing cache degradation for text health output. */
export function formatModelPricingHealthLine(summary: HealthSummary): string | null {
  const modelPricing = summary.modelPricing;
  if (!modelPricing || modelPricing.state === "disabled") {
    return null;
  }
  if (modelPricing.state === "ok") {
    return null;
  }
  const detail = modelPricing.detail ? ` (${modelPricing.detail})` : "";
  return `Model pricing: warning (optional pricing refresh degraded)${detail}`;
}

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

/** Formats context engine quarantine state for text health output. */
export function formatContextEngineHealthLine(summary: HealthSummary): string | null {
  const quarantined = summary.contextEngines?.quarantined ?? [];
  if (quarantined.length === 0) {
    return null;
  }
  const engines = quarantined.map((entry) => entry.engineId).join(", ");
  return `Context engine: warning (${quarantined.length} quarantined; downgraded to legacy: ${engines})`;
}

/** Builds dead-lettered inbound and outbound queue health for cached gateway responses. */
export function buildDeliveryQueueHealthSummary(): DeliveryQueueHealthSummary | undefined {
  // Queue health reads are diagnostic; a storage failure must not take the
  // gateway health endpoint down with it.
  let failed: DeliveryQueueHealthSummary["failed"] = [];
  try {
    failed = countFailedDeliveryQueueEntries().map((queue) => {
      const entry: DeliveryQueueHealthSummary["failed"][number] = {
        queueName: queue.queueName,
        count: queue.count,
      };
      if (queue.oldestFailedAt != null) {
        entry.oldestFailedAt = queue.oldestFailedAt;
      }
      return entry;
    });
  } catch (error) {
    debugHealth(undefined, "outbound delivery queue health read failed", error);
  }
  let ingressFailed: NonNullable<DeliveryQueueHealthSummary["ingressFailed"]> = [];
  try {
    ingressFailed = countFailedChannelIngressQueueEntries().map((queue) => {
      const entry: NonNullable<DeliveryQueueHealthSummary["ingressFailed"]>[number] = {
        channelId: queue.channelId,
        accountId: queue.accountId,
        count: queue.count,
      };
      if (queue.oldestFailedAt != null) {
        entry.oldestFailedAt = queue.oldestFailedAt;
      }
      return entry;
    });
  } catch (error) {
    debugHealth(undefined, "channel ingress queue health read failed", error);
  }
  if (failed.length === 0 && ingressFailed.length === 0) {
    return undefined;
  }
  return {
    failed,
    ...(ingressFailed.length > 0 ? { ingressFailed } : {}),
  };
}

/** Formats dead-lettered delivery queue entries for text health output. */
export function formatDeliveryQueueHealthLine(
  summary: HealthSummary,
  now = Date.now(),
): string | null {
  const failed = summary.deliveryQueues?.failed ?? [];
  const ingressFailed = summary.deliveryQueues?.ingressFailed ?? [];
  if (failed.length === 0 && ingressFailed.length === 0) {
    return null;
  }
  const counts = [
    ...failed.map((queue) => `${queue.queueName}: ${queue.count}`),
    ...ingressFailed.map(
      (queue) => `inbound ${queue.channelId}/${queue.accountId}: ${queue.count}`,
    ),
  ].join(", ");
  const oldest = [...failed, ...ingressFailed]
    .map((queue) => queue.oldestFailedAt)
    .filter((value): value is number => typeof value === "number");
  const oldestNote =
    oldest.length > 0 ? `; oldest ${formatDurationHuman(now - Math.min(...oldest))} ago` : "";
  return `Delivery queue: warning (dead-lettered entries — ${counts}${oldestNote})`;
}

/** Formats config hot-reload watcher degradation for text health output. */
export function formatConfigReloadHealthLine(summary: HealthSummary): string | null {
  if (summary.configReload?.hotReloadStatus !== "disabled") {
    return null;
  }
  return "Config hot reload: disabled (watcher retries exhausted; restart the gateway to restore it)";
}

const resolveHeartbeatSummary = (cfg: OpenClawConfig, agentId: string) =>
  resolveHeartbeatSummaryForAgent(cfg, agentId);

const resolveAgentOrder = (cfg: OpenClawConfig) => {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const entries = Array.isArray(cfg.agents?.list) ? cfg.agents.list : [];
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
};

const buildSessionSummary = async (storePath: string, agentId?: string) => {
  const { listSessionEntriesReadOnly } = await import("../config/sessions/session-accessor.js");
  const { isTransientSqliteError } = await import("../infra/unhandled-rejections.js");
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
  const recent = sessions.slice(0, 5).map((s) => ({
    key: s.key,
    updatedAt: s.updatedAt || null,
    age: s.updatedAt ? Date.now() - s.updatedAt : null,
  }));
  return {
    path: storePath,
    count: sessions.length,
    recent,
  } satisfies HealthSummary["sessions"];
};

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

function readBooleanField(value: unknown, key: string): boolean | undefined {
  const record = asNullableRecord(value);
  if (!record) {
    return undefined;
  }
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

const hasAccountValue = (account: unknown): boolean => account !== null && account !== undefined;

function resolveProbeAccountEnabled(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  account: unknown;
  diagnostics: string[];
}): boolean {
  const fallback = readBooleanField(params.account, "enabled") ?? true;
  try {
    return resolveChannelAccountEnabled({
      plugin: params.plugin,
      account: params.account,
      cfg: params.cfg,
    });
  } catch (error) {
    params.diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to evaluate enabled state (${formatErrorMessage(error)}).`,
    );
    return fallback;
  }
}

async function resolveProbeAccountConfigured(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  account: unknown;
  diagnostics: string[];
}): Promise<boolean> {
  const fallback = readBooleanField(params.account, "configured") ?? true;
  try {
    return await resolveChannelAccountConfigured({
      plugin: params.plugin,
      account: params.account,
      cfg: params.cfg,
      readAccountConfiguredField: true,
    });
  } catch (error) {
    params.diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to evaluate configured state (${formatErrorMessage(error)}).`,
    );
    return fallback;
  }
}

async function resolveHealthAccountContext(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): Promise<{
  probeAccount: unknown;
  snapshotAccount: unknown;
  enabled: boolean;
  configured: boolean;
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  let account: unknown;
  try {
    account = params.plugin.config.resolveAccount(params.cfg, params.accountId);
  } catch (error) {
    diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to resolve account (${formatErrorMessage(error)}).`,
    );
  }
  let inspectedAccount: unknown;
  try {
    inspectedAccount = await inspectChannelAccount(params);
  } catch (error) {
    diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to inspect account (${formatErrorMessage(error)}).`,
    );
  }

  const probeAccount = hasAccountValue(account) ? account : inspectedAccount;
  if (!hasAccountValue(probeAccount)) {
    return {
      probeAccount: {},
      snapshotAccount: {},
      enabled: false,
      configured: false,
      diagnostics,
    };
  }
  const snapshotAccount = hasAccountValue(inspectedAccount) ? inspectedAccount : probeAccount;

  const enabled = resolveProbeAccountEnabled({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
    account: probeAccount,
    diagnostics,
  });
  const configured = await resolveProbeAccountConfigured({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
    account: probeAccount,
    diagnostics,
  });

  return {
    probeAccount,
    snapshotAccount,
    enabled,
    configured,
    diagnostics,
  };
}

/** Builds the gateway-side health snapshot for channels, agents, plugins, and sessions. */
export async function getHealthSnapshot(params?: {
  timeoutMs?: number;
  probe?: boolean;
  includeSensitive?: boolean;
  runtimeSnapshot?: ChannelRuntimeSnapshot;
  eventLoop?: HealthSummary["eventLoop"];
  configReloadHotReloadStatus?: GatewayHotReloadStatus;
}): Promise<HealthSummary> {
  const timeoutMs = params?.timeoutMs;
  const cfg = await readRuntimeHealthConfig();
  const { defaultAgentId, ordered } = resolveAgentOrder(cfg);
  const channelBindings = buildChannelAccountBindings(cfg);
  const sessionCache = new Map<string, HealthSummary["sessions"]>();
  const agents: AgentHealthSummary[] = [];
  for (const entry of ordered) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
    const sessionCacheKey = `${storePath}\0${entry.id}`;
    const sessions =
      sessionCache.get(sessionCacheKey) ?? (await buildSessionSummary(storePath, entry.id));
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
    (await buildSessionSummary(
      resolveStorePath(cfg.session?.store, { agentId: defaultAgentId }),
      defaultAgentId,
    ));

  const start = Date.now();
  const cappedTimeout = resolveTimerTimeoutMs(timeoutMs, DEFAULT_TIMEOUT_MS, 50);
  const doProbe = params?.probe !== false;
  const includeSensitive = params?.includeSensitive !== false;
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
      if (enabled && configured && doProbe && plugin.status?.probeAccount) {
        try {
          probe = await plugin.status.probeAccount({
            account: probeAccount,
            timeoutMs: cappedTimeout,
            cfg,
          });
          lastProbeAt = Date.now();
        } catch (err) {
          probe = { ok: false, error: formatErrorMessage(err) };
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
        params?.runtimeSnapshot?.channelAccounts[plugin.id]?.[accountId] ??
        (accountId === defaultAccountId ? params?.runtimeSnapshot?.channels[plugin.id] : undefined);
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
      if (!health.healthy) {
        snapshot.healthState = health.reason;
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
  const summary: HealthSummary = {
    ok: true,
    ts: Date.now(),
    durationMs: Date.now() - start,
    readiness: buildRuntimeReadiness({
      configLoaded: true,
      gateway: "responding",
      plugins: pluginHealth,
      coreConditions: buildUnobservedGatewayConditions(),
    }),
    ...(params?.eventLoop ? { eventLoop: params.eventLoop } : {}),
    ...(pluginHealth ? { plugins: pluginHealth } : {}),
    ...(contextEngineHealth ? { contextEngines: contextEngineHealth } : {}),
    ...(deliveryQueueHealth ? { deliveryQueues: deliveryQueueHealth } : {}),
    ...(params?.configReloadHotReloadStatus
      ? { configReload: { hotReloadStatus: params.configReloadHotReloadStatus } }
      : {}),
    modelPricing: getGatewayModelPricingHealth({ enabled: isGatewayModelPricingEnabled(cfg) }),
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

  return summary;
}

/** Runs the `openclaw health` command against the gateway and renders JSON or text. */
export async function healthCommand(
  opts: {
    json?: boolean;
    timeoutMs?: number;
    verbose?: boolean;
    config?: OpenClawConfig;
    token?: string;
    password?: string;
    localPortOverride?: number;
  },
  runtime: RuntimeEnv,
) {
  const cfg = opts.config ?? (await readBestEffortHealthConfig());
  // Always query the running gateway; do not open a direct Baileys socket here.
  let summary: HealthSummary;
  try {
    summary = await withProgress(
      {
        label: "Checking gateway health…",
        indeterminate: true,
        enabled: opts.json !== true,
      },
      async () =>
        await callGateway<HealthSummary>({
          method: "health",
          params: opts.verbose ? { probe: true } : undefined,
          timeoutMs: opts.timeoutMs,
          config: cfg,
          token: opts.token,
          password: opts.password,
          localPortOverride: opts.localPortOverride,
        }),
    );
  } catch (error) {
    if (
      await emitReachableGatewayAuthDiagnostic({
        error,
        config: cfg,
        runtime,
        timeoutMs: opts.timeoutMs,
        token: opts.token,
        password: opts.password,
        localPortOverride: opts.localPortOverride,
        json: opts.json,
      })
    ) {
      return;
    }
    if (isGatewayHealthAuthUnavailableError(error)) {
      throw error;
    }
    if (opts.json) {
      const payload = formatGatewayTransportErrorJson(error);
      if (payload) {
        writeRuntimeJson(runtime, payload);
        runtime.exit(1);
        return;
      }
    }
    throw error;
  }
  // Gateway reachability defines success; channel issues are reported but not fatal here.
  const fatal = false;

  if (opts.json) {
    writeRuntimeJson(runtime, summary);
  } else {
    const debugEnabled = isDiagnosticFlagEnabled("health", cfg);
    const rich = isRich();
    if (opts.verbose) {
      const details = buildGatewayConnectionDetails({
        config: cfg,
        localPortOverride: opts.localPortOverride,
      });
      logGatewayConnectionDetails({
        runtime,
        info,
        message: details.message,
      });
    }
    const localAgents = resolveAgentOrder(cfg);
    const defaultAgentId = summary.defaultAgentId ?? localAgents.defaultAgentId;
    const agents = Array.isArray(summary.agents) ? summary.agents : [];
    const resolvedAgents =
      agents.length > 0
        ? agents
        : await Promise.all(
            localAgents.ordered.map(async (entry) => {
              const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
              return {
                agentId: entry.id,
                name: entry.name,
                isDefault: entry.id === localAgents.defaultAgentId,
                heartbeat: resolveHeartbeatSummary(cfg, entry.id),
                sessions: await buildSessionSummary(storePath, entry.id),
              } satisfies AgentHealthSummary;
            }),
          );
    const displayAgents = opts.verbose
      ? resolvedAgents
      : resolvedAgents.filter((agent) => agent.agentId === defaultAgentId);
    const channelBindings = buildChannelAccountBindings(cfg);
    const displayPlugins = listReadOnlyChannelPluginsForConfig(cfg, {
      includeSetupFallbackPlugins: false,
    });
    if (debugEnabled) {
      runtime.log(info("[debug] local channel accounts"));
      for (const plugin of displayPlugins) {
        const accountIds = plugin.config.listAccountIds(cfg);
        const defaultAccountId = resolveChannelDefaultAccountId({
          plugin,
          cfg,
          accountIds,
        });
        runtime.log(
          `  ${plugin.id}: accounts=${accountIds.join(", ") || "(none)"} default=${defaultAccountId}`,
        );
        for (const accountId of accountIds) {
          const { snapshotAccount, configured, diagnostics } = await resolveHealthAccountContext({
            plugin,
            cfg,
            accountId,
          });
          const record = asNullableRecord(snapshotAccount);
          const tokenSource =
            record && typeof record.tokenSource === "string" ? record.tokenSource : undefined;
          runtime.log(
            `    - ${accountId}: configured=${configured}${tokenSource ? ` tokenSource=${tokenSource}` : ""}`,
          );
          for (const diagnostic of diagnostics) {
            runtime.log(`      ! ${diagnostic}`);
          }
        }
      }
      runtime.log(info("[debug] bindings map"));
      for (const [channelId, byAgent] of channelBindings.entries()) {
        const entries = Array.from(byAgent.entries()).map(
          ([agentId, ids]) => `${agentId}=[${ids.join(", ")}]`,
        );
        runtime.log(`  ${channelId}: ${entries.join(" ")}`);
      }
      runtime.log(info("[debug] gateway channel probes"));
      for (const [channelId, channelSummary] of Object.entries(summary.channels ?? {})) {
        const accounts = channelSummary.accounts ?? {};
        const probes = Object.entries(accounts).map(([accountId, accountSummary]) => {
          const probe = asNullableRecord(accountSummary.probe);
          const bot = probe ? asNullableRecord(probe.bot) : null;
          const username = bot && typeof bot.username === "string" ? bot.username : null;
          return `${accountId}=${username ?? "(no bot)"}`;
        });
        runtime.log(`  ${channelId}: ${probes.join(", ") || "(none)"}`);
      }
    }
    const channelAccountFallbacks = Object.fromEntries(
      displayPlugins.map((plugin) => {
        const accountIds = plugin.config.listAccountIds(cfg);
        const defaultAccountId = resolveChannelDefaultAccountId({
          plugin,
          cfg,
          accountIds,
        });
        const preferred = resolvePreferredAccountId({
          accountIds,
          defaultAccountId,
          boundAccounts: channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [],
        });
        return [plugin.id, [preferred] as string[]] as const;
      }),
    );
    const accountIdsByChannel = (() => {
      const entries = displayAgents.length > 0 ? displayAgents : resolvedAgents;
      const byChannel: Record<string, string[]> = {};
      for (const [channelId, byAgent] of channelBindings.entries()) {
        const accountIds: string[] = [];
        for (const agent of entries) {
          const ids = byAgent.get(agent.agentId) ?? [];
          for (const id of ids) {
            if (!accountIds.includes(id)) {
              accountIds.push(id);
            }
          }
        }
        if (accountIds.length > 0) {
          byChannel[channelId] = accountIds;
        }
      }
      for (const [channelId, fallbackIds] of Object.entries(channelAccountFallbacks)) {
        if (!byChannel[channelId] || byChannel[channelId].length === 0) {
          byChannel[channelId] = fallbackIds;
        }
      }
      return byChannel;
    })();
    const channelLines =
      Object.keys(accountIdsByChannel).length > 0
        ? formatHealthChannelLines(summary, {
            accountMode: opts.verbose ? "all" : "default",
            accountIdsByChannel,
          })
        : formatHealthChannelLines(summary, {
            accountMode: opts.verbose ? "all" : "default",
          });
    for (const line of channelLines) {
      runtime.log(styleHealthChannelLine(line, rich));
    }
    const eventLoopLine = formatEventLoopHealthLine(summary);
    if (eventLoopLine) {
      runtime.log(styleHealthChannelLine(eventLoopLine, rich));
    }
    const modelPricingLine = formatModelPricingHealthLine(summary);
    if (modelPricingLine) {
      runtime.log(styleHealthChannelLine(modelPricingLine, rich));
    }
    const contextEngineLine = formatContextEngineHealthLine(summary);
    if (contextEngineLine) {
      runtime.log(styleHealthChannelLine(contextEngineLine, rich));
    }
    const deliveryQueueLine = formatDeliveryQueueHealthLine(summary);
    if (deliveryQueueLine) {
      runtime.log(styleHealthChannelLine(deliveryQueueLine, rich));
    }
    const configReloadLine = formatConfigReloadHealthLine(summary);
    if (configReloadLine) {
      runtime.log(styleHealthChannelLine(configReloadLine, rich));
    }
    for (const plugin of displayPlugins) {
      const channelSummary = summary.channels?.[plugin.id];
      if (!channelSummary || channelSummary.linked !== true) {
        continue;
      }
      if (!plugin.status?.logSelfId) {
        continue;
      }
      const boundAccounts = channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [];
      const accountIds = plugin.config.listAccountIds(cfg);
      const defaultAccountId = resolveChannelDefaultAccountId({
        plugin,
        cfg,
        accountIds,
      });
      const accountId = resolvePreferredAccountId({
        accountIds,
        defaultAccountId,
        boundAccounts,
      });
      const accountContext = await resolveHealthAccountContext({
        plugin,
        cfg,
        accountId,
      });
      if (!accountContext.enabled || !accountContext.configured) {
        continue;
      }
      if (accountContext.diagnostics.length > 0) {
        continue;
      }
      try {
        plugin.status.logSelfId({
          account: accountContext.probeAccount,
          cfg,
          runtime,
          includeChannelPrefix: true,
        });
      } catch (error) {
        debugHealth(cfg, "logSelfId.failed", {
          channel: plugin.id,
          accountId,
          error: formatErrorMessage(error),
        });
      }
    }

    if (resolvedAgents.length > 0) {
      const agentLabels = resolvedAgents.map((agent) =>
        agent.isDefault ? `${agent.agentId} (default)` : agent.agentId,
      );
      runtime.log(info(`Agents: ${agentLabels.join(", ")}`));
    }
    const heartbeatParts = displayAgents
      .map((agent) => {
        const everyMs = agent.heartbeat?.everyMs;
        const label = everyMs ? formatDurationParts(everyMs) : "disabled";
        return `${label} (${agent.agentId})`;
      })
      .filter(Boolean);
    if (heartbeatParts.length > 0) {
      runtime.log(info(`Heartbeat interval: ${heartbeatParts.join(", ")}`));
    }
    if (displayAgents.length === 0) {
      runtime.log(
        info(`Session store: ${summary.sessions.path} (${summary.sessions.count} entries)`),
      );
      if (summary.sessions.recent.length > 0) {
        for (const r of summary.sessions.recent) {
          runtime.log(
            `- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 60000)}m ago` : "no activity"})`,
          );
        }
      }
    } else {
      for (const agent of displayAgents) {
        runtime.log(
          info(
            `Session store (${agent.agentId}): ${agent.sessions.path} (${agent.sessions.count} entries)`,
          ),
        );
        if (agent.sessions.recent.length > 0) {
          for (const r of agent.sessions.recent) {
            runtime.log(
              `- ${r.key} (${r.updatedAt ? `${Math.round((Date.now() - r.updatedAt) / 60000)}m ago` : "no activity"})`,
            );
          }
        }
      }
    }
  }

  if (fatal) {
    runtime.exit(1);
  }
}

async function readBestEffortHealthConfig(): Promise<OpenClawConfig> {
  const { readBestEffortConfig } = await loadConfigRuntime();
  return await readBestEffortConfig();
}

async function readRuntimeHealthConfig(): Promise<OpenClawConfig> {
  const { getRuntimeConfig } = await loadConfigRuntime();
  return getRuntimeConfig();
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

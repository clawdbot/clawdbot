/** Collects and renders gateway health for channels, agents, plugins, and sessions. */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { styleHealthChannelLine } from "../../packages/terminal-core/src/health-style.js";
import { isRich } from "../../packages/terminal-core/src/theme.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { probeGatewayStatus } from "../cli/daemon-cli/probe.js";
import { withProgress } from "../cli/progress.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  buildGatewayConnectionDetails,
  buildGatewayProbeConnectionDetails,
  callGateway,
  formatGatewayAuthErrorJson,
  formatGatewayClientRequestErrorJson,
  formatGatewayTransportErrorJson,
  isGatewayCredentialsRequiredError,
} from "../gateway/call.js";
import { isGatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { resolveHealthAccountContext } from "../gateway/health/account-context.js";
import {
  buildHealthSessionSummary as buildSessionSummary,
  resolveHealthAgentOrder as resolveAgentOrder,
} from "../gateway/health/collector.js";
import type { AgentHealthSummary, HealthSummary } from "../gateway/health/types.js";
import { info } from "../globals.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../infra/errors.js";
import {
  formatDurationCompact,
  formatDurationHuman,
} from "../infra/format-time/format-duration.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildChannelAccountBindings, resolvePreferredAccountId } from "../routing/bindings.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  buildCredentialsRequiredHealthDiagnostic,
  buildRateLimitedHealthDiagnostic,
  gatewayConnectErrorWasRateLimited,
  GATEWAY_HEALTH_REACHABLE_LINE,
  gatewayProbeResultSawGateway,
  gatewayProbeResultWasRateLimited,
} from "./gateway-health-auth-diagnostic.js";
import { formatHealthChannelLines } from "./health-format.js";
import { logGatewayConnectionDetails } from "./status.gateway-connection.js";
export { formatHealthChannelLines } from "./health-format.js";
export type { HealthSummary } from "../gateway/health/types.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const healthLog = createSubsystemLogger("health");

const debugHealth = (
  cfg: OpenClawConfig | undefined,
  message: string,
  meta?: Record<string, unknown>,
) => {
  if (isDiagnosticFlagEnabled("health", cfg)) {
    healthLog.info(message, meta);
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
  const directRateLimit = gatewayConnectErrorWasRateLimited(params.error);
  if (!directRateLimit && !isGatewayHealthAuthUnavailableError(params.error)) {
    return false;
  }
  if (directRateLimit) {
    const diagnostic = buildRateLimitedHealthDiagnostic(params.error);
    if (params.json) {
      writeRuntimeJson(params.runtime, diagnostic);
    } else {
      params.runtime.log(GATEWAY_HEALTH_REACHABLE_LINE);
      params.runtime.log(diagnostic.error.message);
    }
    params.runtime.exit(1);
    return true;
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
  const diagnostic = gatewayProbeResultWasRateLimited(probe)
    ? buildRateLimitedHealthDiagnostic()
    : buildCredentialsRequiredHealthDiagnostic();
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
  const degradedFor =
    eventLoop.degraded && eventLoop.degradedSinceMs != null
      ? ` for ${formatDurationCompact(eventLoop.degradedSinceMs) ?? "0s"}`
      : "";
  const reasons = eventLoop.reasons.length > 0 ? ` reasons=${eventLoop.reasons.join(",")}` : "";
  return `Gateway event loop: ${state}${degradedFor}${reasons} max=${Math.round(
    eventLoop.delayMaxMs,
  )}ms p99=${Math.round(eventLoop.delayP99Ms)}ms util=${eventLoop.utilization} cpu=${
    eventLoop.cpuCoreRatio
  }`;
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
    if (opts.json) {
      const payload =
        formatGatewayAuthErrorJson(error) ??
        formatGatewayClientRequestErrorJson(error) ??
        formatGatewayTransportErrorJson(error);
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

    if (Number.isFinite(summary.durationMs)) {
      runtime.log(info(`Gateway probe duration: ${summary.durationMs}ms`));
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

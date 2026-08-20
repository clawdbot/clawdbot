/** Heavy local-state and presentation path for successful text health output. */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { styleHealthChannelLine } from "../../packages/terminal-core/src/health-style.js";
import { isRich } from "../../packages/terminal-core/src/theme.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { resolveSessionStorePathCore } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayConnectionDetails } from "../gateway/call.js";
import { resolveHealthAccountContext } from "../gateway/health/account-context.js";
import { buildHealthSessionSummary, resolveHealthAgentOrder } from "../gateway/health/collector.js";
import type { AgentHealthSummary, HealthSummary } from "../gateway/health/types.js";
import { info } from "../globals.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildChannelAccountBindings, resolvePreferredAccountId } from "../routing/bindings.js";
import type { RuntimeEnv } from "../runtime.js";
import {
  formatConfigReloadHealthLine,
  formatContextEngineHealthLine,
  formatDeliveryQueueHealthLine,
  formatEventLoopHealthLine,
  formatHealthChannelLines,
  formatHealthDurationParts,
} from "./health-format.js";
import { logGatewayConnectionDetails } from "./status.gateway-connection.js";

const healthLog = createSubsystemLogger("health");

function debugHealth(cfg: OpenClawConfig, message: string, meta?: Record<string, unknown>): void {
  if (isDiagnosticFlagEnabled("health", cfg)) {
    healthLog.info(message, meta);
  }
}

export async function renderHealthText(params: {
  config: OpenClawConfig;
  summary: HealthSummary;
  runtime: RuntimeEnv;
  verbose?: boolean;
  ignoreEnvUrlOverride?: boolean;
  localPortOverride?: number;
}): Promise<void> {
  const cfg = params.config;
  const summary = params.summary;
  const runtime = params.runtime;
  const rich = isRich();
  if (params.verbose) {
    const details = buildGatewayConnectionDetails({
      config: cfg,
      ignoreEnvUrlOverride: params.ignoreEnvUrlOverride,
      localPortOverride: params.localPortOverride,
    });
    logGatewayConnectionDetails({ runtime, info, message: details.message });
  }

  const localAgents = resolveHealthAgentOrder(cfg);
  const defaultAgentId = summary.defaultAgentId ?? localAgents.defaultAgentId;
  const agents = Array.isArray(summary.agents) ? summary.agents : [];
  const resolvedAgents =
    agents.length > 0
      ? agents
      : await Promise.all(
          localAgents.ordered.map(async (entry) => {
            const storePath = resolveSessionStorePathCore(cfg.session?.store, {
              agentId: entry.id,
            });
            return {
              agentId: entry.id,
              name: entry.name,
              isDefault: entry.id === localAgents.defaultAgentId,
              heartbeat: resolveHeartbeatSummaryForAgent(cfg, entry.id),
              sessions: await buildHealthSessionSummary(storePath, entry.id),
            } satisfies AgentHealthSummary;
          }),
        );
  const displayAgents =
    params.verbose || !defaultAgentId
      ? resolvedAgents
      : resolvedAgents.filter((agent) => agent.agentId === defaultAgentId);
  const channelBindings = buildChannelAccountBindings(cfg);
  const displayPlugins = listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupFallbackPlugins: false,
  });

  if (isDiagnosticFlagEnabled("health", cfg)) {
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
        boundAccounts: defaultAgentId
          ? (channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [])
          : [],
      });
      const fallbackIds: string[] = [preferred];
      return [plugin.id, fallbackIds] as const;
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
          accountMode: params.verbose ? "all" : "default",
          accountIdsByChannel,
        })
      : formatHealthChannelLines(summary, {
          accountMode: params.verbose ? "all" : "default",
        });
  for (const line of channelLines) {
    runtime.log(styleHealthChannelLine(line, rich));
  }
  for (const line of [
    formatEventLoopHealthLine(summary),
    formatContextEngineHealthLine(summary),
    formatDeliveryQueueHealthLine(summary),
    formatConfigReloadHealthLine(summary),
  ]) {
    if (line) {
      runtime.log(styleHealthChannelLine(line, rich));
    }
  }

  for (const plugin of displayPlugins) {
    const channelSummary = summary.channels?.[plugin.id];
    if (!channelSummary || channelSummary.linked !== true || !plugin.status?.logSelfId) {
      continue;
    }
    const boundAccounts = defaultAgentId
      ? (channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [])
      : [];
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({ plugin, cfg, accountIds });
    const accountId = resolvePreferredAccountId({ accountIds, defaultAccountId, boundAccounts });
    const accountContext = await resolveHealthAccountContext({
      plugin,
      cfg,
      accountId,
    });
    if (
      !accountContext.enabled ||
      !accountContext.configured ||
      accountContext.diagnostics.length > 0
    ) {
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
      return `${everyMs ? formatHealthDurationParts(everyMs) : "disabled"} (${agent.agentId})`;
    })
    .filter(Boolean);
  if (heartbeatParts.length > 0) {
    runtime.log(info(`Heartbeat interval: ${heartbeatParts.join(", ")}`));
  }
  if (displayAgents.length === 0) {
    runtime.log(
      info(`Session store: ${summary.sessions.path} (${summary.sessions.count} entries)`),
    );
    for (const recent of summary.sessions.recent) {
      runtime.log(
        `- ${recent.key} (${recent.updatedAt ? `${Math.round((Date.now() - recent.updatedAt) / 60000)}m ago` : "no activity"})`,
      );
    }
    return;
  }
  for (const agent of displayAgents) {
    runtime.log(
      info(
        `Session store (${agent.agentId}): ${agent.sessions.path} (${agent.sessions.count} entries)`,
      ),
    );
    for (const recent of agent.sessions.recent) {
      runtime.log(
        `- ${recent.key} (${recent.updatedAt ? `${Math.round((Date.now() - recent.updatedAt) / 60000)}m ago` : "no activity"})`,
      );
    }
  }
}

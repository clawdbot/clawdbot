/** Collects and renders gateway health for channels, agents, plugins, and sessions. */
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { styleHealthChannelLine } from "../../packages/terminal-core/src/health-style.js";
import { isRich } from "../../packages/terminal-core/src/theme.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import { probeGatewayStatus } from "../cli/daemon-cli/probe.js";
import { withProgress } from "../cli/progress.js";
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
  buildHealthAgentSummaries,
  resolveHealthAgentOrder as resolveAgentOrder,
} from "../gateway/health/collector.js";
import type { HealthSummary } from "../gateway/health/types.js";
import { info } from "../globals.js";
import { isDiagnosticFlagEnabled } from "../infra/diagnostic-flags.js";
import { formatErrorMessage } from "../infra/errors.js";
import { formatExactDuration } from "../infra/format-time/format-duration-exact.js";
import { formatDurationCompact } from "../infra/format-time/format-duration.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { buildChannelAccountBindings, resolvePreferredAccountId } from "../routing/bindings.js";
import { ExitError, type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import {
  buildCredentialsRequiredHealthDiagnostic,
  buildRateLimitedHealthDiagnostic,
  gatewayConnectErrorWasRateLimited,
  GATEWAY_HEALTH_REACHABLE_LINE,
  gatewayProbeResultSawGateway,
  gatewayProbeResultWasRateLimited,
} from "./gateway-health-auth-diagnostic.js";
import { formatDeliveryQueueHealthLine, formatHealthChannelLines } from "./health-format.js";
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
  ignoreEnvUrlOverride?: boolean;
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
    ignoreEnvUrlOverride: params.ignoreEnvUrlOverride,
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

/** Formats config hot-reload watcher degradation for text health output. */
export function formatConfigReloadHealthLine(summary: HealthSummary): string | null {
  if (summary.configReload?.hotReloadStatus !== "disabled") {
    return null;
  }
  return "Config hot reload: disabled (watcher retries exhausted; restart the gateway to restore it)";
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
    ignoreEnvUrlOverride?: boolean;
    localPortOverride?: number;
  },
  runtime: RuntimeEnv,
) {
  const cfg = opts.config ?? (await readNonObservingHealthConfig());
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
          sharedStateMode: "read-only",
          ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
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
        ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
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
  if (opts.json) {
    writeRuntimeJson(runtime, summary);
  } else {
    const debugEnabled = isDiagnosticFlagEnabled("health", cfg);
    const rich = isRich();
    if (opts.verbose) {
      const details = buildGatewayConnectionDetails({
        config: cfg,
        ignoreEnvUrlOverride: opts.ignoreEnvUrlOverride,
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
      agents.length > 0 ? agents : await buildHealthAgentSummaries(cfg, localAgents);
    const displayAgents =
      opts.verbose || !defaultAgentId
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
          const { inspectedAccount, probeAccount, configured, diagnostics } =
            await resolveHealthAccountContext({
              plugin,
              cfg,
              accountId,
            });
          const record = asNullableRecord(inspectedAccount ?? probeAccount);
          const tokenSource =
            record && typeof record.tokenSource === "string" ? record.tokenSource : undefined;
          runtime.log(
            `    - ${accountId}: configured=${configured ?? "unknown"}${tokenSource ? ` tokenSource=${tokenSource}` : ""}`,
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
      const boundAccounts = defaultAgentId
        ? (channelBindings.get(plugin.id)?.get(defaultAgentId) ?? [])
        : [];
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
      if (
        accountContext.probeAccount === undefined ||
        !accountContext.enabled ||
        accountContext.configured !== true
      ) {
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
        const label = everyMs ? formatExactDuration(everyMs, "unknown", true) : "disabled";
        return `${label} (${agent.agentId})`;
      })
      .filter(Boolean);
    if (heartbeatParts.length > 0) {
      runtime.log(info(`Heartbeat interval: ${heartbeatParts.join(", ")}`));
    }
    const sessionGroups =
      displayAgents.length > 0
        ? displayAgents
        : [{ agentId: undefined, sessions: summary.sessions }];
    for (const { agentId, sessions } of sessionGroups) {
      const label = agentId ? `Session store (${agentId})` : "Session store";
      runtime.log(info(`${label}: ${sessions.path} (${sessions.count} entries)`));
      for (const { key, age } of sessions.recent) {
        // A remote Gateway owns these ages; the CLI clock may differ.
        runtime.log(
          `- ${key} (${age === null ? "no activity" : `${Math.round(age / 60000)}m ago`})`,
        );
      }
    }
  }
}

/**
 * Runs `healthCommand` inside a host flow (wizard/onboard/doctor). The command's
 * CLI-style `runtime.exit(1)` diagnostic paths surface as a thrown `ExitError`,
 * so the host reports the failure and keeps running instead of dying mid-flow.
 */
export async function healthCommandNonExiting(
  opts: Parameters<typeof healthCommand>[0],
  runtime: RuntimeEnv,
): Promise<void> {
  await healthCommand(opts, {
    ...runtime,
    exit: (code) => {
      throw new ExitError(code);
    },
  });
}

export async function readNonObservingHealthConfig(): Promise<OpenClawConfig> {
  const { readConfigFileSnapshot } = await loadConfigRuntime();
  const snapshot = await readConfigFileSnapshot({
    observe: false,
    pluginValidation: "core-only",
  });
  return snapshot.runtimeConfig ?? snapshot.config;
}

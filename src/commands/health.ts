import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../channels/plugins/read-only.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";
import { withProgress } from "../cli/progress.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildGatewayConnectionDetails, callGateway } from "../gateway/call.js";
import { info } from "../globals.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { getActivePluginRegistry } from "../plugins/runtime.js";
import { buildChannelAccountBindings, resolvePreferredAccountId } from "../routing/bindings.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { asNullableRecord } from "../shared/record-coerce.js";
import { styleHealthChannelLine } from "../terminal/health-style.js";
import { isRich } from "../terminal/theme.js";
import { formatHealthChannelLines } from "./health-format.js";
import type {
  AgentHealthSummary,
  ChannelAccountHealthSummary,
  ChannelHealthSummary,
  HealthSummary,
  PluginHealthErrorSummary,
  PluginHealthSummary,
} from "./health.types.js";
import { logGatewayConnectionDetails } from "./status.gateway-connection.js";
export { formatHealthChannelLines } from "./health-format.js";
export type {
  AgentHealthSummary,
  ChannelAccountHealthSummary,
  ChannelHealthSummary,
  HealthSummary,
} from "./health.types.js";

const DEFAULT_TIMEOUT_MS = 10_000;

type ConfigModule = typeof import("../config/config.js");

let configModulePromise: Promise<ConfigModule> | undefined;

function loadConfigModule(): Promise<ConfigModule> {
  configModulePromise ??= import("../config/config.js");
  return configModulePromise;
}

const debugHealth = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH)) {
    console.warn("[health:debug]", ...args);
  }
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

const buildSessionSummary = async (storePath: string) => {
  const { loadSessionStore } = await import("../config/sessions/store.js");
  const store = loadSessionStore(storePath);
  const sessions = Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([key, entry]) => ({ key, updatedAt: entry?.updatedAt ?? 0 }))
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
  if (!registry) {
    return undefined;
  }
  const loaded = registry.plugins
    .filter((plugin) => plugin.status === "loaded")
    .map((plugin) => plugin.id)
    .toSorted((left, right) => left.localeCompare(right));
  const errors = registry.plugins
    .filter((plugin) => plugin.status === "error")
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
  if (loaded.length === 0 && errors.length === 0) {
    return undefined;
  }
  return { loaded, errors };
}

async function inspectHealthAccount(plugin: ChannelPlugin, cfg: OpenClawConfig, accountId: string) {
  return (
    plugin.config.inspectAccount?.(cfg, accountId) ??
    (await inspectReadOnlyChannelAccount({
      channelId: plugin.id,
      cfg,
      accountId,
    }))
  );
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  const record = asNullableRecord(value);
  if (!record) {
    return undefined;
  }
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

async function resolveHealthAccountContext(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): Promise<{
  account: unknown;
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
    account = await inspectHealthAccount(params.plugin, params.cfg, params.accountId);
  }

  if (!account) {
    return {
      account: {},
      enabled: false,
      configured: false,
      diagnostics,
    };
  }

  const enabledFallback = readBooleanField(account, "enabled") ?? true;
  let enabled = enabledFallback;
  if (params.plugin.config.isEnabled) {
    try {
      enabled = params.plugin.config.isEnabled(account, params.cfg);
    } catch (error) {
      enabled = enabledFallback;
      diagnostics.push(
        `${params.plugin.id}:${params.accountId}: failed to evaluate enabled state (${formatErrorMessage(error)}).`,
      );
    }
  }

  const configuredFallback = readBooleanField(account, "configured") ?? true;
  let configured = configuredFallback;
  if (params.plugin.config.isConfigured) {
    try {
      configured = await params.plugin.config.isConfigured(account, params.cfg);
    } catch (error) {
      configured = configuredFallback;
      diagnostics.push(
        `${params.plugin.id}:${params.accountId}: failed to evaluate configured state (${formatErrorMessage(error)}).`,
      );
    }
  }

  return { account, enabled, configured, diagnostics };
}

export async function getHealthSnapshot(params?: {
  timeoutMs?: number;
  probe?: boolean;
}): Promise<HealthSummary> {
  const timeoutMs = params?.timeoutMs;
  const { loadConfig } = await loadConfigModule();
  const cfg = loadConfig();
  const { defaultAgentId, ordered } = resolveAgentOrder(cfg);
  const channelBindings = buildChannelAccountBindings(cfg);
  const sessionCache = new Map<string, HealthSummary["sessions"]>();
  const agents: AgentHealthSummary[] = [];
  for (const entry of ordered) {
    const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
    const sessions = sessionCache.get(storePath) ?? (await buildSessionSummary(storePath));
    sessionCache.set(storePath, sessions);
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
    (await buildSessionSummary(resolveStorePath(cfg.session?.store, { agentId: defaultAgentId })));

  const start = Date.now();
  const cappedTimeout = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : Math.max(50, timeoutMs);
  const doProbe = params?.probe !== false;
  const channels: Record<string, ChannelHealthSummary> = {};
  const plugins = listReadOnlyChannelPluginsForConfig(cfg, {
    includeSetupRuntimeFallback: false,
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
      new Set(Array.from(channelBindings.get(plugin.id)?.values() ?? []).flatMap((ids) => ids)),
    );
    const accountIdsToProbe = Array.from(
      new Set(
        [preferredAccountId, defaultAccountId, ...accountIds, ...boundAccountIdsAll].filter(
          (value) => value && value.trim(),
        ),
      ),
    );
    debugHealth("channel", {
      id: plugin.id,
      accountIds,
      defaultAccountId,
      boundAccounts,
      preferredAccountId,
      accountIdsToProbe,
    });
    const accountSummaries: Record<string, ChannelAccountHealthSummary> = {};

    for (const accountId of accountIdsToProbe) {
      const { account, enabled, configured, diagnostics } = await resolveHealthAccountContext({
        plugin,
        cfg,
        accountId,
      });
      if (diagnostics.length > 0) {
        debugHealth("account.diagnostics", { channel: plugin.id, accountId, diagnostics });
      }

      let probe: unknown;
      let lastProbeAt: number | null = null;
      if (enabled && configured && doProbe && plugin.status?.probeAccount) {
        try {
          probe = await plugin.status.probeAccount({
            account,
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
        debugHealth("probe.bot", { channel: plugin.id, accountId, username: bot.username });
      }

      const snapshot: ChannelAccountSnapshot = {
        accountId,
        enabled,
        configured,
      };
      if (probe !== undefined) {
        snapshot.probe = probe;
      }
      if (lastProbeAt) {
        snapshot.lastProbeAt = lastProbeAt;
      }

      const summary = plugin.status?.buildChannelSummary
        ? await plugin.status.buildChannelSummary({
            account,
            cfg,
            defaultAccountId: accountId,
            snapshot,
          })
        : undefined;
      const record =
        summary && typeof summary === "object"
          ? (summary as ChannelAccountHealthSummary)
          : ({
              accountId,
              configured,
              probe,
              lastProbeAt,
            } satisfies ChannelAccountHealthSummary);
      if (record.configured === undefined) {
        record.configured = configured;
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
    const fallbackSummary = defaultSummary ?? accountSummaries[Object.keys(accountSummaries)[0]];
    if (fallbackSummary) {
      channels[plugin.id] = {
        ...fallbackSummary,
        accounts: accountSummaries,
      } satisfies ChannelHealthSummary;
    }
  }

  const pluginHealth = buildPluginHealthSummary();
  const summary: HealthSummary = {
    ok: true,
    ts: Date.now(),
    durationMs: Date.now() - start,
    ...(pluginHealth ? { plugins: pluginHealth } : {}),
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

export async function healthCommand(
  opts: { json?: boolean; timeoutMs?: number; verbose?: boolean; config?: OpenClawConfig },
  runtime: RuntimeEnv,
) {
  const cfg = opts.config ?? (await readBestEffortHealthConfig());
  // Always query the running gateway; do not open a direct Baileys socket here.
  const summary = await withProgress(
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
      }),
  );
  // Gateway reachability defines success; channel issues are reported but not fatal here.
  const fatal = false;

  if (opts.json) {
    writeRuntimeJson(runtime, summary);
  } else {
    const debugEnabled = isTruthyEnvValue(process.env.OPENCLAW_DEBUG_HEALTH);
    const rich = isRich();
    if (opts.verbose) {
      const details = buildGatewayConnectionDetails({ config: cfg });
      logGatewayConnectionDetails({
        runtime,
        info,
        message: details.message,
      });
    }
    const localAgents = resolveAgentOrder(cfg);
    const defaultAgentId = summary.defaultAgentId ?? localAgents.defaultAgentId;
    const agents = Array.isArray(summary.agents) ? summary.agents : [];
    const fallbackAgents: AgentHealthSummary[] = [];
    for (const entry of localAgents.ordered) {
      const storePath = resolveStorePath(cfg.session?.store, { agentId: entry.id });
      fallbackAgents.push({
        agentId: entry.id,
        name: entry.name,
        isDefault: entry.id === localAgents.defaultAgentId,
        heartbeat: resolveHeartbeatSummary(cfg, entry.id),
        sessions: await buildSessionSummary(storePath),
      });
    }
    const resolvedAgents = agents.length > 0 ? agents : fallbackAgents;
    const displayAgents = opts.verbose
      ? resolvedAgents
      : resolvedAgents.filter((agent) => agent.agentId === defaultAgentId);
    const channelBindings = buildChannelAccountBindings(cfg);
    const displayPlugins = listReadOnlyChannelPluginsForConfig(cfg, {
      includeSetupRuntimeFallback: false,
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
          const { account, configured, diagnostics } = await resolveHealthAccountContext({
            plugin,
            cfg,
            accountId,
          });
          const record = asNullableRecord(account);
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
          account: accountContext.account,
          cfg,
          runtime,
          includeChannelPrefix: true,
        });
      } catch (error) {
        debugHealth("logSelfId.failed", {
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
  const { readBestEffortConfig } = await loadConfigModule();
  return await readBestEffortConfig();
}

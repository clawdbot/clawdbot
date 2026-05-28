import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { readSessionStoreReadOnly } from "../config/sessions/store-read.js";
import { resolveSessionTotalTokens, type SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveCronStorePath } from "../cron/store.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { resolveHeartbeatSummaryForAgent } from "../infra/heartbeat-summary.js";
import { peekSystemEvents } from "../infra/system-events.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import {
  summarizeActionableTaskAuditFindings,
  summarizeRetainedLostTaskAuditFindings,
} from "../tasks/task-registry.audit.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import type { HeartbeatStatus, SessionStatus, StatusSummary } from "./status.types.js";

const RECENT_SESSION_LIMIT = 10;

const channelSummaryModuleLoader = createLazyImportLoader(
  () => import("../infra/channel-summary.js"),
);
const channelPluginIdsModuleLoader = createLazyImportLoader(
  () => import("../plugins/channel-plugin-ids.js"),
);
const linkChannelModuleLoader = createLazyImportLoader(() => import("./status.link-channel.js"));
const taskRegistryMaintenanceModuleLoader = createLazyImportLoader(
  () => import("../tasks/task-registry.maintenance.js"),
);

function loadChannelSummaryModule() {
  return channelSummaryModuleLoader.load();
}

function loadChannelPluginIdsModule() {
  return channelPluginIdsModuleLoader.load();
}

function loadLinkChannelModule() {
  return linkChannelModuleLoader.load();
}

const loadStatusSummaryRuntimeModule = createLazyRuntimeSurface(
  () => import("./status.summary.runtime.js"),
  ({ statusSummaryRuntime }) => statusSummaryRuntime,
);

function loadTaskRegistryMaintenanceModule() {
  return taskRegistryMaintenanceModuleLoader.load();
}

const buildFlags = (entry?: SessionEntry): string[] => {
  if (!entry) {
    return [];
  }
  const flags: string[] = [];
  const think = entry?.thinkingLevel;
  if (typeof think === "string" && think.length > 0) {
    flags.push(`think:${think}`);
  }
  const verbose = entry?.verboseLevel;
  if (typeof verbose === "string" && verbose.length > 0) {
    flags.push(`verbose:${verbose}`);
  }
  if (typeof entry?.fastMode === "boolean") {
    flags.push(entry.fastMode ? "fast" : "fast:off");
  }
  const reasoning = entry?.reasoningLevel;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    flags.push(`reasoning:${reasoning}`);
  }
  const elevated = entry?.elevatedLevel;
  if (typeof elevated === "string" && elevated.length > 0) {
    flags.push(`elevated:${elevated}`);
  }
  if (entry?.systemSent) {
    flags.push("system");
  }
  if (entry?.abortedLastRun) {
    flags.push("aborted");
  }
  const sessionId = entry?.sessionId as unknown;
  if (typeof sessionId === "string" && sessionId.length > 0) {
    flags.push(`id:${sessionId}`);
  }
  return flags;
};

function discountRetainedLostTaskFailures(
  tasks: StatusSummary["tasks"],
  retainedLostCount: number,
): StatusSummary["tasks"] {
  if (retainedLostCount <= 0 || tasks.failures <= 0) {
    return tasks;
  }
  return {
    ...tasks,
    failures: Math.max(0, tasks.failures - retainedLostCount),
  };
}

function hasUserPinnedModelSelection(entry: SessionEntry | undefined): boolean {
  if (!entry?.modelOverride) {
    return false;
  }
  if (entry.modelOverrideSource === "user") {
    return true;
  }
  if (entry.modelOverrideSource === "auto") {
    return false;
  }
  return !hasSessionAutoModelFallbackProvenance(entry);
}

type SessionCandidate = {
  key: string;
  entry: SessionEntry | undefined;
  updatedAt: number | null;
};

function compareSessionCandidatesByUpdatedAt(left: SessionCandidate, right: SessionCandidate) {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
}

function listSessionCandidates(store: Record<string, SessionEntry | undefined>) {
  return Object.entries(store)
    .filter(([key]) => key !== "global" && key !== "unknown")
    .map(([key, entry]) => ({
      key,
      entry,
      updatedAt: entry?.updatedAt ?? null,
    }))
    .toSorted(compareSessionCandidatesByUpdatedAt);
}

export function redactSensitiveStatusSummary(summary: StatusSummary): StatusSummary {
  return {
    ...summary,
    sessions: {
      ...summary.sessions,
      paths: [],
      defaults: {
        model: null,
        contextTokens: null,
      },
      recent: [],
      byAgent: summary.sessions.byAgent.map((entry) => ({
        ...entry,
        path: "[redacted]",
        recent: [],
      })),
    },
  };
}

export async function getStatusSummary(
  options: {
    includeSensitive?: boolean;
    includeChannelSummary?: boolean;
    config?: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
  } = {},
): Promise<StatusSummary> {
  const { includeSensitive = true, includeChannelSummary = true } = options;
  const {
    classifySessionKey,
    resolveConfiguredStatusModelRef,
    resolveContextTokensForModel,
    resolveSessionRuntimeLabel,
    resolveSessionModelRef,
  } = await loadStatusSummaryRuntimeModule();
  const cfg = options.config ?? getRuntimeConfig();
  const channelScopeConfig =
    options.sourceConfig === undefined
      ? { config: cfg }
      : { config: cfg, activationSourceConfig: options.sourceConfig };
  const needsChannelPlugins =
    includeChannelSummary &&
    (await loadChannelPluginIdsModule().then(({ hasConfiguredChannelsForReadOnlyScope }) =>
      hasConfiguredChannelsForReadOnlyScope(channelScopeConfig),
    ));
  const linkContext = needsChannelPlugins
    ? await loadLinkChannelModule().then(({ resolveLinkChannelContext }) =>
        resolveLinkChannelContext(cfg, { sourceConfig: options.sourceConfig }),
      )
    : null;
  const agentList = listGatewayAgentsBasic(cfg);
  const heartbeatAgents: HeartbeatStatus[] = agentList.agents.map((agent) => {
    const summary = resolveHeartbeatSummaryForAgent(cfg, agent.id);
    return {
      agentId: agent.id,
      enabled: summary.enabled,
      every: summary.every,
      everyMs: summary.everyMs,
    } satisfies HeartbeatStatus;
  });
  const channelSummary = needsChannelPlugins
    ? await loadChannelSummaryModule().then(({ buildChannelSummary }) =>
        buildChannelSummary(cfg, {
          colorize: true,
          includeAllowFrom: true,
          sourceConfig: options.sourceConfig,
        }),
      )
    : [];
  const mainSessionKey = resolveMainSessionKey(cfg);
  const queuedSystemEvents = peekSystemEvents(mainSessionKey);
  const taskMaintenanceModule = await loadTaskRegistryMaintenanceModule();
  taskMaintenanceModule.configureTaskRegistryMaintenance({
    cronStorePath: resolveCronStorePath(cfg.cron?.store),
  });
  const rawTasks = taskMaintenanceModule.getInspectableTaskRegistrySummary();
  const taskAuditFindings = taskMaintenanceModule.getInspectableTaskAuditFindings();
  const now = Date.now();
  const taskAudit = summarizeActionableTaskAuditFindings(taskAuditFindings, { now });
  const taskAuditRetainedLost = summarizeRetainedLostTaskAuditFindings(taskAuditFindings, { now });
  const tasks = discountRetainedLostTaskFailures(rawTasks, taskAuditRetainedLost.count);

  const resolved = resolveConfiguredStatusModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const configModel = resolved.model ?? DEFAULT_MODEL;
  const configContextTokens =
    resolveContextTokensForModel({
      cfg,
      provider: resolved.provider ?? DEFAULT_PROVIDER,
      model: configModel,
      contextTokensOverride: cfg.agents?.defaults?.contextTokens,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
      // Keep `status`/`status --json` startup read-only. These summary lookups
      // should not kick off background provider discovery or plugin scans.
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS;

  const storeCache = new Map<string, Record<string, SessionEntry | undefined>>();
  const candidateCache = new Map<string, SessionCandidate[]>();
  const loadStore = (storePath: string) => {
    const cached = storeCache.get(storePath);
    if (cached) {
      return cached;
    }
    const store = readSessionStoreReadOnly(storePath);
    storeCache.set(storePath, store);
    return store;
  };
  const loadSessionCandidates = (storePath: string) => {
    const cached = candidateCache.get(storePath);
    if (cached) {
      return cached;
    }
    const candidates = listSessionCandidates(loadStore(storePath));
    candidateCache.set(storePath, candidates);
    return candidates;
  };
  const buildSessionRows = (
    candidates: SessionCandidate[],
    opts: { agentIdOverride?: string } = {},
  ) =>
    candidates.map(({ key, entry, updatedAt }) => {
      const age = updatedAt ? now - updatedAt : null;
      const parsedAgentId = parseAgentSessionKey(key)?.agentId;
      const agentId = opts.agentIdOverride ?? parsedAgentId;
      const configuredForSession = resolveConfiguredStatusModelRef({
        cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
        agentId,
      });
      const configuredSessionModel = configuredForSession.model ?? DEFAULT_MODEL;
      const configuredSessionModelLabel = `${configuredForSession.provider ?? DEFAULT_PROVIDER}/${configuredSessionModel}`;
      const resolvedModel = resolveSessionModelRef(cfg, entry, opts.agentIdOverride);
      const model = resolvedModel.model ?? configuredSessionModel ?? null;
      const selectedModelLabel =
        resolvedModel.provider && model ? `${resolvedModel.provider}/${model}` : model;
      const modelSelectionDiffers =
        selectedModelLabel != null &&
        selectedModelLabel !== configuredSessionModelLabel &&
        !areRuntimeModelRefsEquivalent(selectedModelLabel, configuredSessionModelLabel) &&
        hasUserPinnedModelSelection(entry);
      const contextTokens =
        resolveContextTokensForModel({
          cfg,
          provider: resolvedModel.provider,
          model,
          contextTokensOverride: entry?.contextTokens,
          fallbackContextTokens: configContextTokens ?? undefined,
          allowAsyncLoad: false,
        }) ?? null;
      const total = resolveSessionTotalTokens(entry);
      const totalTokensFresh =
        typeof entry?.totalTokens === "number" ? entry?.totalTokensFresh !== false : false;
      const remaining =
        contextTokens != null && total !== undefined ? Math.max(0, contextTokens - total) : null;
      const pct =
        contextTokens && contextTokens > 0 && total !== undefined
          ? Math.min(999, Math.round((total / contextTokens) * 100))
          : null;
      const runtime = resolveSessionRuntimeLabel({
        cfg,
        entry,
        provider: resolvedModel.provider,
        model: model ?? "",
        agentId,
        sessionKey: key,
      });

      return {
        agentId,
        key,
        kind: classifySessionKey(key, entry),
        sessionId: entry?.sessionId,
        updatedAt,
        age,
        thinkingLevel: entry?.thinkingLevel,
        fastMode: entry?.fastMode,
        verboseLevel: entry?.verboseLevel,
        traceLevel: entry?.traceLevel,
        reasoningLevel: entry?.reasoningLevel,
        elevatedLevel: entry?.elevatedLevel,
        systemSent: entry?.systemSent,
        abortedLastRun: entry?.abortedLastRun,
        inputTokens: entry?.inputTokens,
        outputTokens: entry?.outputTokens,
        cacheRead: entry?.cacheRead,
        cacheWrite: entry?.cacheWrite,
        totalTokens: total ?? null,
        totalTokensFresh,
        remainingTokens: remaining,
        percentUsed: pct,
        model,
        configuredModel: configuredSessionModelLabel,
        selectedModel: selectedModelLabel,
        modelSelectionReason: modelSelectionDiffers ? "session override" : null,
        runtime,
        contextTokens,
        flags: buildFlags(entry),
      } satisfies SessionStatus;
    });

  const paths = new Set<string>();
  const byAgent = agentList.agents.map((agent) => {
    const storePath = resolveStorePath(cfg.session?.store, { agentId: agent.id });
    paths.add(storePath);
    const candidates = loadSessionCandidates(storePath);
    const sessions = buildSessionRows(candidates.slice(0, RECENT_SESSION_LIMIT), {
      agentIdOverride: agent.id,
    });
    return {
      agentId: agent.id,
      path: storePath,
      count: candidates.length,
      recent: sessions,
    };
  });

  const allSessions = Array.from(paths)
    .flatMap((storePath) => loadSessionCandidates(storePath))
    .toSorted((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const recent = buildSessionRows(allSessions.slice(0, RECENT_SESSION_LIMIT));
  const totalSessions = allSessions.length;

  const summary: StatusSummary = {
    runtimeVersion: resolveRuntimeServiceVersion(process.env),
    linkChannel: linkContext
      ? {
          id: linkContext.plugin.id,
          label: linkContext.plugin.meta.label ?? "Channel",
          linked: linkContext.linked,
          authAgeMs: linkContext.authAgeMs,
        }
      : undefined,
    heartbeat: {
      defaultAgentId: agentList.defaultId,
      agents: heartbeatAgents,
    },
    channelSummary,
    queuedSystemEvents,
    tasks,
    taskAudit,
    ...(taskAuditRetainedLost.count > 0 ? { taskAuditRetainedLost } : {}),
    sessions: {
      paths: Array.from(paths),
      count: totalSessions,
      defaults: {
        model: configModel ?? null,
        contextTokens: configContextTokens ?? null,
      },
      recent,
      byAgent,
    },
  };
  return includeSensitive ? summary : redactSensitiveStatusSummary(summary);
}

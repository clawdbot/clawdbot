// Builds the status summary used by human and JSON status output.
// It aggregates sessions, tasks, heartbeat, channel summary, and model/runtime metadata.

import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import { getRuntimeConfig, projectConfigOntoRuntimeSourceSnapshot } from "../config/config.js";
import { resolveMainSessionKey } from "../config/sessions/main-session.js";
import {
  hasSessionActiveAutoModelFallback,
  hasSessionAutoModelFallbackProvenance,
} from "../config/sessions/model-override-provenance.js";
import { resolveStorePath } from "../config/sessions/paths.js";
import { listSessionEntries } from "../config/sessions/session-accessor.js";
import { resolveSessionTotalTokens, type SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
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
const staticModelCatalogResolverLoader = createLazyImportLoader(async () => {
  const modelCatalog = await import("../agents/embedded-agent-runner/model.static-catalog.js");
  return {
    resolveManifestModel: modelCatalog.createBundledStaticCatalogModelResolver({
      // Runtime-discovery manifest rows still provide a cold-cache fallback.
      includeRuntimeDiscovery: true,
    }),
    createProviderContextResolver: modelCatalog.createBundledProviderStaticCatalogContextResolver,
  };
});

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

function loadStaticModelCatalogResolvers() {
  return staticModelCatalogResolverLoader.load();
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
  if (entry?.fastMode === "auto") {
    flags.push("fast:auto");
  } else if (typeof entry?.fastMode === "boolean") {
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
  // Retained lost tasks are reported separately; avoid double-counting them as active failures.
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

function normalizeStatusModelPart(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function resolveTrustedSessionContextTokens(params: {
  entry: SessionEntry | undefined;
  provider: string | undefined;
  model: string | null;
}): number | undefined {
  const contextTokens =
    typeof params.entry?.contextTokens === "number" && params.entry.contextTokens > 0
      ? params.entry.contextTokens
      : undefined;
  if (contextTokens === undefined) {
    return undefined;
  }
  if (hasSessionAutoModelFallbackProvenance(params.entry)) {
    return contextTokens;
  }
  const entryProvider = normalizeStatusModelPart(params.entry?.modelProvider);
  const entryModel = normalizeStatusModelPart(params.entry?.model);
  const resolvedProvider = normalizeStatusModelPart(params.provider);
  const resolvedModel = normalizeStatusModelPart(params.model);
  if (!entryModel || !resolvedModel || entryModel !== resolvedModel) {
    return undefined;
  }
  if (entryProvider && resolvedProvider && entryProvider !== resolvedProvider) {
    return undefined;
  }
  return contextTokens;
}

type SessionCandidate = {
  key: string;
  entry: SessionEntry;
  updatedAt: number | null;
};

function compareSessionCandidatesByUpdatedAt(left: SessionCandidate, right: SessionCandidate) {
  return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
}

function selectRecentSessionCandidates(
  candidates: SessionCandidate[],
  limit: number,
): SessionCandidate[] {
  const selected: SessionCandidate[] = [];
  for (const candidate of candidates) {
    const insertAt = selected.findIndex(
      (selectedCandidate) => compareSessionCandidatesByUpdatedAt(candidate, selectedCandidate) < 0,
    );
    if (insertAt >= 0) {
      selected.splice(insertAt, 0, candidate);
      if (selected.length > limit) {
        selected.pop();
      }
    } else if (selected.length < limit) {
      selected.push(candidate);
    }
  }
  return selected;
}

function listSessionCandidates(storePath: string, agentId?: string) {
  return (
    listSessionEntries({
      ...(agentId ? { agentId } : {}),
      storePath,
    })
      // Compatibility aggregate buckets are not real user sessions.
      .filter(({ sessionKey }) => sessionKey !== "global" && sessionKey !== "unknown")
      .map(({ sessionKey, entry }) => ({
        key: sessionKey,
        entry,
        updatedAt: entry?.updatedAt ?? null,
      }))
  );
}

/** Removes session paths and recent session details from a status summary. */
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

/** Builds the aggregate status summary for agents, sessions, tasks, heartbeat, and channels. */
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
    resolveStatusModelComparisonLabel,
    resolveStatusModelLookupRef,
    waitForContextWindowCacheLoad,
  } = await loadStatusSummaryRuntimeModule();
  const cfg = options.config ?? getRuntimeConfig();
  await waitForContextWindowCacheLoad();
  const contextSourceConfig =
    options.sourceConfig !== undefined
      ? options.sourceConfig
      : projectConfigOntoRuntimeSourceSnapshot(cfg);
  const { resolveManifestModel, createProviderContextResolver } =
    await loadStaticModelCatalogResolvers();
  const resolveProviderContext = createProviderContextResolver({ cfg });
  const modelContextCache = new Map<
    string,
    Promise<{ modelContextWindow?: number; modelContextTokens?: number }>
  >();
  const resolveStaticModelContext = async (
    provider: string | undefined,
    model: string | undefined,
  ) => {
    if (!provider || !model) {
      return {};
    }
    const key = `${provider}\0${model}`;
    const cached = modelContextCache.get(key);
    if (cached) {
      return cached;
    }
    const resolved = (async () => {
      try {
        const entry =
          resolveManifestModel({ provider, modelId: model }) ??
          (await resolveProviderContext({ provider, modelId: model }));
        return {
          ...(entry?.contextWindow ? { modelContextWindow: entry.contextWindow } : {}),
          ...(entry?.contextTokens ? { modelContextTokens: entry.contextTokens } : {}),
        };
      } catch {
        return {};
      }
    })();
    modelContextCache.set(key, resolved);
    return resolved;
  };
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
  taskMaintenanceModule.configureTaskRegistryMaintenance();
  const inspectableTasks = taskMaintenanceModule.reconcileInspectableTasks();
  const rawTasks = taskMaintenanceModule.getInspectableTaskRegistrySummary(inspectableTasks);
  const taskAuditFindings = taskMaintenanceModule.getInspectableTaskAuditFindings(inspectableTasks);
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
  const configModelContext = await resolveStaticModelContext(
    resolved.provider ?? DEFAULT_PROVIDER,
    configModel,
  );
  const configContextTokens =
    resolveContextTokensForModel({
      cfg,
      sourceCfg: contextSourceConfig,
      provider: resolved.provider ?? DEFAULT_PROVIDER,
      model: configModel,
      ...configModelContext,
      contextTokensOverride: cfg.agents?.defaults?.contextTokens,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
      // Keep `status`/`status --json` startup read-only. These summary lookups
      // use offline static catalogs but never start live provider discovery.
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS;

  const candidateCache = new Map<string, SessionCandidate[]>();
  const loadSessionCandidates = (storePath: string, agentId?: string) => {
    const cacheKey = `${storePath}\0${agentId ?? ""}`;
    const cached = candidateCache.get(cacheKey);
    if (cached) {
      return cached;
    }
    const candidates = listSessionCandidates(storePath, agentId);
    candidateCache.set(cacheKey, candidates);
    return candidates;
  };
  const buildSessionRows = async (
    candidates: SessionCandidate[],
    opts: { agentIdOverride?: string } = {},
  ) =>
    Promise.all(
      candidates.map(async ({ key, entry, updatedAt }) => {
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
        const lookupModel =
          resolveStatusModelLookupRef({
            provider: resolvedModel.provider,
            model,
            defaultProvider: configuredForSession.provider ?? DEFAULT_PROVIDER,
          }) ?? resolvedModel;
        const lookupModelId = lookupModel.model ?? model;
        const modelContext = await resolveStaticModelContext(
          lookupModel.provider,
          lookupModelId ?? undefined,
        );
        const selectedModelLabel =
          resolvedModel.provider && model ? `${resolvedModel.provider}/${model}` : model;
        const configuredSessionModelComparisonLabel = resolveStatusModelComparisonLabel({
          provider: configuredForSession.provider ?? DEFAULT_PROVIDER,
          model: configuredSessionModel,
          defaultProvider: DEFAULT_PROVIDER,
        });
        const selectedModelComparisonLabel = resolveStatusModelComparisonLabel({
          provider: resolvedModel.provider,
          model,
          defaultProvider: configuredForSession.provider ?? DEFAULT_PROVIDER,
        });
        const modelSelectionDiffers =
          selectedModelComparisonLabel != null &&
          configuredSessionModelComparisonLabel != null &&
          selectedModelComparisonLabel !== configuredSessionModelComparisonLabel &&
          !areRuntimeModelRefsEquivalent(
            selectedModelComparisonLabel,
            configuredSessionModelComparisonLabel,
          ) &&
          (hasUserPinnedModelSelection(entry) || hasSessionActiveAutoModelFallback(entry));
        // Session rows show the live selected model and warn for user-pinned
        // differences as well as runtime fallback selections (#96126).
        const contextTokens =
          resolveContextTokensForModel({
            cfg,
            sourceCfg: contextSourceConfig,
            provider: lookupModel.provider,
            model: lookupModelId,
            ...modelContext,
            contextTokensOverride: resolveTrustedSessionContextTokens({
              entry,
              provider: lookupModel.provider,
              model: lookupModelId,
            }),
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
          provider: lookupModel.provider,
          model: lookupModelId ?? "",
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
          modelSelectionReason: modelSelectionDiffers
            ? hasUserPinnedModelSelection(entry)
              ? "session override"
              : "fallback selected"
            : null,
          runtime,
          contextTokens,
          flags: buildFlags(entry),
        } satisfies SessionStatus;
      }),
    );

  const storeSources = agentList.agents.map((agent) => ({
    agentId: agent.id,
    storePath: resolveStorePath(cfg.session?.store, { agentId: agent.id }),
  }));
  const paths = new Set<string>();
  const pathCounts = new Map<string, number>();
  for (const source of storeSources) {
    paths.add(source.storePath);
    pathCounts.set(source.storePath, (pathCounts.get(source.storePath) ?? 0) + 1);
  }

  const byAgent = await Promise.all(
    agentList.agents.map(async (agent) => {
      const storePath = resolveStorePath(cfg.session?.store, { agentId: agent.id });
      const candidates = loadSessionCandidates(storePath, agent.id);
      const sessions = await buildSessionRows(
        selectRecentSessionCandidates(candidates, RECENT_SESSION_LIMIT),
        { agentIdOverride: agent.id },
      );
      return {
        agentId: agent.id,
        path: storePath,
        count: candidates.length,
        recent: sessions,
      };
    }),
  );

  const allSessions = storeSources
    .filter((source, index, sources) => {
      return sources.findIndex((candidate) => candidate.storePath === source.storePath) === index;
    })
    .flatMap((source) =>
      loadSessionCandidates(
        source.storePath,
        pathCounts.get(source.storePath) === 1 ? source.agentId : undefined,
      ),
    );
  const recent = await buildSessionRows(
    selectRecentSessionCandidates(allSessions, RECENT_SESSION_LIMIT),
  );
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

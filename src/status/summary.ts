// Builds the status summary used by human and JSON status output.
// It aggregates sessions, tasks, heartbeat, channel summary, and model/runtime metadata.

import { expectDefined } from "@openclaw/normalization-core";
import { withAgentRosterFactsBatch } from "../agents/agent-scope-config.js";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { areRuntimeModelRefsEquivalent } from "../agents/model-runtime-aliases.js";
import { getRuntimeConfig } from "../config/config.js";
import { resolveProjectedSessionContextTokens } from "../config/sessions/context-token-provenance.js";
import { resolveCanonicalMainSessionKey } from "../config/sessions/main-session-key.js";
import {
  hasSessionActiveAutoModelFallback,
  hasUserPinnedModelSelection,
} from "../config/sessions/model-override-provenance.js";
import {
  loadExactSessionEntryReadOnly,
  type SessionEntrySummary,
} from "../config/sessions/session-accessor.js";
import {
  resolveFreshSessionTotalTokens,
  resolveSessionTotalTokens,
  type SessionEntry,
} from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.js";
import { listGatewayAgentsBasic } from "../gateway/agent-list.js";
import { resolveHeartbeatSessionKey } from "../infra/heartbeat-runner-session.js";
import { resolveHeartbeatSummariesForAgents } from "../infra/heartbeat-summary-projection.js";
import { hasResolvableHeartbeatOwnerRoute } from "../infra/outbound/targets.js";
import { readStartupMigrationWarning } from "../infra/state-migrations.messages.js";
import { peekSystemEvents } from "../infra/system-events.js";
import {
  listActiveDegradedPlugins,
  toPublicPluginVerificationDiagnostic,
} from "../plugins/runtime-degraded-state.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import {
  listActiveDegradedSecretOwners,
  redactSecretDegradationReason,
} from "../secrets/runtime-degraded-state.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { createLazyRuntimeSurface } from "../shared/lazy-runtime.js";
import {
  summarizeActionableTaskAuditFindings,
  summarizeRetainedLostTaskAuditFindings,
} from "../tasks/task-registry.audit.js";
import { deliveryContextFromSession } from "../utils/delivery-context.shared.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { readStatusSessionStores } from "./session-stores.js";
import type { HeartbeatStatus, SessionStatus, StatusSummary } from "./types.js";

const RECENT_SESSION_LIMIT = 10;

const channelSummaryModuleLoader = createLazyImportLoader(
  () => import("../infra/channel-summary.js"),
);
const channelPluginIdsModuleLoader = createLazyImportLoader(
  () => import("../plugins/channel-plugin-ids.js"),
);
const linkChannelModuleLoader = createLazyImportLoader(() => import("./link-channel.js"));
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

const loadStatusSummaryRuntimeModule = createLazyRuntimeSurface(
  () => import("./summary.runtime.js"),
  ({ statusSummaryRuntime }) => statusSummaryRuntime,
);

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

function compareSessionCandidatesByUpdatedAt(
  left: SessionEntrySummary,
  right: SessionEntrySummary,
) {
  return (right.entry.updatedAt ?? 0) - (left.entry.updatedAt ?? 0);
}

function selectRecentSessionCandidates(
  candidates: SessionEntrySummary[],
  limit: number,
): SessionEntrySummary[] {
  const selected: SessionEntrySummary[] = [];
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

async function prepareSessionStatusDetails(cfg: OpenClawConfig, now: number) {
  const {
    classifySessionKey,
    resolveConfiguredStatusModelRef,
    resolveAuthoredModelContextTokens,
    resolveContextTokensForModel,
    resolveSessionRuntime,
    resolveSessionModelRef,
    resolveStatusModelComparisonLabel,
    resolveStatusModelLookupRef,
    waitForContextWindowCacheLoad,
  } = await loadStatusSummaryRuntimeModule();
  await waitForContextWindowCacheLoad();
  const { resolveManifestModel, createProviderContextResolver } =
    await staticModelCatalogResolverLoader.load();
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
      provider: resolved.provider ?? DEFAULT_PROVIDER,
      model: configModel,
      ...configModelContext,
      fallbackContextTokens: DEFAULT_CONTEXT_TOKENS,
      // Keep `status`/`status --json` startup read-only. These summary lookups
      // use offline static catalogs but never start live provider discovery.
      allowAsyncLoad: false,
    }) ?? DEFAULT_CONTEXT_TOKENS;

  // Aggregate rows reuse this request's completed agent projection, with independent DTOs.
  const sessionRows = new Map<SessionEntrySummary, SessionStatus>();
  const buildSessionRows = async (candidates: SessionEntrySummary[]) =>
    Promise.all(
      candidates.map(async (candidate) => {
        const cached = sessionRows.get(candidate);
        if (cached) {
          return { ...cached, flags: [...cached.flags] };
        }
        const { sessionKey: key, entry } = candidate;
        const agentId = parseAgentSessionKey(key)?.agentId;
        const updatedAt = entry.updatedAt ?? null;
        const age = updatedAt ? now - updatedAt : null;
        const configuredForSession = resolveConfiguredStatusModelRef({
          cfg,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
          agentId,
        });
        const configuredSessionModel = configuredForSession.model ?? DEFAULT_MODEL;
        const configuredSessionModelLabel = `${configuredForSession.provider ?? DEFAULT_PROVIDER}/${configuredSessionModel}`;
        const resolvedModel = resolveSessionModelRef(cfg, entry, agentId);
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
        const runtimeMatchesConfiguredModel =
          selectedModelComparisonLabel != null &&
          configuredSessionModelComparisonLabel != null &&
          areRuntimeModelRefsEquivalent(
            selectedModelComparisonLabel,
            configuredSessionModelComparisonLabel,
            { config: cfg },
          );
        const contextModelProvider = runtimeMatchesConfiguredModel
          ? configuredForSession.provider
          : lookupModel.provider;
        const modelSelectionDiffers =
          selectedModelComparisonLabel != null &&
          configuredSessionModelComparisonLabel != null &&
          selectedModelComparisonLabel !== configuredSessionModelComparisonLabel &&
          !runtimeMatchesConfiguredModel &&
          (hasUserPinnedModelSelection(entry) || hasSessionActiveAutoModelFallback(entry));
        // Session rows show the live selected model and warn for user-pinned
        // differences as well as runtime fallback selections (#96126).
        const resolvedContextTokens = resolveContextTokensForModel({
          cfg,
          provider: lookupModel.provider,
          model: lookupModelId,
          ...modelContext,
          fallbackContextTokens: configContextTokens ?? undefined,
          allowAsyncLoad: false,
        });
        const runtime = resolveSessionRuntime({
          cfg,
          entry,
          provider: lookupModel.provider,
          model: lookupModelId ?? "",
          agentId,
          sessionKey: key,
        });
        const contextTokens =
          resolveProjectedSessionContextTokens({
            entry,
            provider: lookupModel.provider,
            model: lookupModelId,
            agentHarnessId: runtime.id,
            resolvedContextTokens,
            authoredContextTokens: resolveAuthoredModelContextTokens({
              cfg,
              provider: lookupModel.provider,
              modelProvider: contextModelProvider,
              model: lookupModelId,
            }),
          }) ?? null;
        const total = resolveSessionTotalTokens(entry);
        const freshTotal = resolveFreshSessionTotalTokens(entry);
        const totalTokensFresh = freshTotal !== undefined;
        const remaining =
          contextTokens != null && freshTotal !== undefined
            ? Math.max(0, contextTokens - freshTotal)
            : null;
        const pct =
          contextTokens && contextTokens > 0 && freshTotal !== undefined
            ? Math.min(999, Math.round((freshTotal / contextTokens) * 100))
            : null;
        const row = {
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
          runtime: runtime.label,
          contextTokens,
          flags: buildFlags(entry),
        } satisfies SessionStatus;
        sessionRows.set(candidate, row);
        return row;
      }),
    );

  return {
    defaults: { model: configModel, contextTokens: configContextTokens },
    buildSessionRows,
  };
}

/** Builds the aggregate status summary for agents, sessions, tasks, heartbeat, and channels. */
export async function getStatusSummary(
  options: {
    includeSensitive?: boolean;
    includeChannelSummary?: boolean;
    config?: OpenClawConfig;
    sourceConfig?: OpenClawConfig;
    hostDesktopStatus?: import("../gateway/desktop/host-source.js").HostDesktopStatus;
  } = {},
): Promise<StatusSummary> {
  const { includeSensitive = true, includeChannelSummary = true } = options;
  const cfg = options.config ?? getRuntimeConfig();
  const channelScopeConfig =
    options.sourceConfig === undefined
      ? { config: cfg }
      : { config: cfg, activationSourceConfig: options.sourceConfig };
  const needsChannelPlugins =
    includeChannelSummary &&
    (await channelPluginIdsModuleLoader
      .load()
      .then(({ hasConfiguredChannelsForReadOnlyScope }) =>
        hasConfiguredChannelsForReadOnlyScope(channelScopeConfig),
      ));
  const linkContext = needsChannelPlugins
    ? await linkChannelModuleLoader
        .load()
        .then(({ resolveLinkChannelContext }) =>
          resolveLinkChannelContext(cfg, { sourceConfig: options.sourceConfig }),
        )
    : null;
  const agentList = listGatewayAgentsBasic(cfg);
  // One roster-facts batch spans enrollment and the per-agent owner-route
  // lookup below: outside it every resolveAgentConfig re-walks the roster and
  // a large fleet stalls the loop for the whole projection (#137570).
  const heartbeatAgents: HeartbeatStatus[] = withAgentRosterFactsBatch(cfg, () => {
    const heartbeatSummaries = resolveHeartbeatSummariesForAgents(
      cfg,
      agentList.agents.map((agent) => agent.id),
    );
    return agentList.agents.map((agent, index) => {
      const summary = expectDefined(heartbeatSummaries[index], "heartbeat summary");
      let waitingForRoute = false;
      if (summary.enabled && (summary.target === "last" || summary.target === "owner")) {
        const heartbeatSession = resolveHeartbeatSessionKey(
          cfg,
          agent.id,
          summary.session === undefined ? undefined : { session: summary.session },
        );
        // Only these enabled targets consume the session route. Keep the probe
        // read-only so status cannot create, register, or migrate an absent store.
        const entry = loadExactSessionEntryReadOnly({
          agentId: agent.id,
          storePath: heartbeatSession.storePath,
          sessionKey: heartbeatSession.sessionKey,
        })?.entry;
        const route = deliveryContextFromSession(entry);
        // Owner status uses the runner's synchronous stage-1 decision.
        waitingForRoute =
          summary.target === "last"
            ? !(route?.channel && route.to)
            : !hasResolvableHeartbeatOwnerRoute({
                cfg,
                agentId: agent.id,
                entry,
                heartbeat: {
                  ...cfg.agents?.defaults?.heartbeat,
                  ...resolveAgentConfig(cfg, agent.id)?.heartbeat,
                },
              });
      }
      return {
        agentId: agent.id,
        enabled: summary.enabled,
        every: summary.every,
        everyMs: summary.everyMs,
        waitingForRoute,
      } satisfies HeartbeatStatus;
    });
  });
  const channelSummary = needsChannelPlugins
    ? await channelSummaryModuleLoader.load().then(({ buildChannelSummary }) =>
        buildChannelSummary(cfg, {
          colorize: true,
          includeAllowFrom: true,
          sourceConfig: options.sourceConfig,
        }),
      )
    : [];
  // Fleet status reads every main queue without selecting an ambient execution owner.
  // Global session scope shares one queue, so include it only once.
  const mainSessionKeys = new Set(
    agentList.agents.map(({ id: agentId }) =>
      resolveCanonicalMainSessionKey({
        agentId,
        mainKey: cfg.session?.mainKey,
        sessionScope: cfg.session?.scope,
      }),
    ),
  );
  const queuedSystemEvents = [...mainSessionKeys].flatMap(peekSystemEvents);
  const taskMaintenanceModule = await taskRegistryMaintenanceModuleLoader.load();
  // Status may overlap a live Gateway, so task inspection must not initialize
  // the writable process registry or its schema-owning shared-state handle.
  const taskInspection = taskMaintenanceModule.inspectTasksReadOnly();
  const inspectableTasks = taskInspection.tasks;
  const rawTasks = taskMaintenanceModule.getInspectableTaskRegistrySummary(inspectableTasks);
  const taskAuditFindings = taskMaintenanceModule.getInspectableTaskAuditFindings(inspectableTasks);
  const now = Date.now();
  const taskAudit = summarizeActionableTaskAuditFindings(taskAuditFindings, { now });
  const taskAuditRetainedLost = summarizeRetainedLostTaskAuditFindings(taskAuditFindings, { now });
  const tasks: StatusSummary["tasks"] = {
    ...discountRetainedLostTaskFailures(rawTasks, taskAuditRetainedLost.count),
    ...(taskInspection.state === "migration-required"
      ? {
          warning:
            "Task history is unavailable until Gateway startup or openclaw doctor --fix repairs the state database.",
        }
      : {}),
  };

  const sessionDetails = includeSensitive ? await prepareSessionStatusDetails(cfg, now) : undefined;

  const sessionStores = readStatusSessionStores(
    cfg,
    agentList.agents,
    includeSensitive ? RECENT_SESSION_LIMIT : 0,
  );
  const byAgent = await Promise.all(
    sessionStores.byAgent.map(async ({ agent, path, count, recent }) => ({
      agentId: agent.id,
      path: includeSensitive ? path : "[redacted]",
      count,
      recent: sessionDetails ? await sessionDetails.buildSessionRows(recent) : [],
    })),
  );
  const recent = sessionDetails
    ? await sessionDetails.buildSessionRows(
        selectRecentSessionCandidates(sessionStores.recent, RECENT_SESSION_LIMIT),
      )
    : [];
  const hostDesktopStatus =
    options.hostDesktopStatus ??
    (
      await (
        await import("../gateway/desktop/host-source.js")
      ).inspectHostDesktop({ config: cfg.desktop?.host })
    ).status;
  return {
    runtimeVersion: resolveRuntimeServiceVersion(process.env),
    hostDesktop: hostDesktopStatus,
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
    startupMigrationWarning: readStartupMigrationWarning(includeSensitive),
    degradedSecretOwners: listActiveDegradedSecretOwners().map(
      ({ ownerKind, ownerId, state, degradationState, paths: ownerPaths, reason }) => {
        const redactedReason: string = redactSecretDegradationReason(reason);
        return {
          ownerKind,
          ownerId,
          state,
          degradationState: degradationState ?? "cold",
          paths: ownerPaths,
          reason: redactedReason,
        };
      },
    ),
    degradedPlugins: listActiveDegradedPlugins().map(({ pluginId, state, diagnostic }) => ({
      pluginId,
      state,
      diagnostic: toPublicPluginVerificationDiagnostic(diagnostic),
    })),
    tasks,
    taskAudit,
    ...(taskAuditRetainedLost.count > 0 ? { taskAuditRetainedLost } : {}),
    sessions: {
      paths: includeSensitive ? sessionStores.paths : [],
      count: sessionStores.count,
      defaults: sessionDetails?.defaults ?? { model: null, contextTokens: null },
      recent,
      byAgent,
    },
  };
}

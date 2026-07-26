import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionCreatedActor } from "../../packages/gateway-protocol/src/index.js";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveFastModeState } from "../agents/fast-mode.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import {
  getSessionDisplaySubagentRunByChildSessionKey,
  getSubagentSessionStartedAt,
  isSubagentRunLive,
  resolveSubagentSessionStatus,
} from "../agents/subagent-registry-read.js";
import { resolveQueueSettings } from "../auto-reply/reply/queue/settings.js";
import { resolveEffectiveResponseUsage } from "../auto-reply/thinking.js";
import {
  buildGroupDisplayName,
  buildGroupDisplayTitle,
  resolveFreshSessionTotalTokens,
  resolveSessionGoalDisplayState,
  type SessionEntry,
} from "../config/sessions.js";
import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectPluginSessionExtensionsSync } from "../plugins/host-hook-state.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveActiveSessionAgentStatus } from "../sessions/session-agent-status.js";
import { resolveNonNegativeNumber } from "../shared/number-coercion.js";
import { getUserProfileListItem } from "../state/user-profiles.js";
import { projectSessionDeliveryFields } from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { sessionHasAutomation } from "./session-automation-index.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { readSessionTitleFieldsFromTranscript as readScopedSessionTitleFieldsFromTranscript } from "./session-transcript-readers.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import {
  buildCompactionCheckpointPreview,
  deriveSessionTitle,
  deriveSessionUnread,
  resolveEstimatedSessionCostUsd,
  resolveLatestCompactionCheckpoint,
  resolvePositiveNumber,
  resolveProjectableCompactionCheckpoints,
  resolveRuntimeChildSessionKeys,
  resolveSessionRuntimeMs,
} from "./session-utils-core.js";
import {
  resolveGatewaySessionThinkingProjectionInternal,
  resolveSessionDisplayModelIdentityRefCached,
} from "./session-utils-model.js";
import {
  mergeChildSessionKeys,
  resolveChildSessionKeys,
  resolveSessionSelectedModelRef,
  resolveTranscriptUsageFallback,
} from "./session-utils-projection.js";
import {
  classifySessionKey,
  isGroupOrChannelDisplaySession,
  parseGroupKey,
} from "./session-utils-store.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/** Adds the current human profile label without persisting rename-prone display data. */
export function projectSessionActor(
  actor: SessionEntry["createdActor"],
  userProfileLabelById: Map<string, string | undefined> = new Map(),
): SessionCreatedActor | undefined {
  if (!actor) {
    return undefined;
  }
  const id = normalizeOptionalString(actor.id);
  if (actor.type !== "human" || !id) {
    return { type: actor.type, ...(id ? { id } : {}) };
  }
  let label = userProfileLabelById.get(id);
  if (!userProfileLabelById.has(id)) {
    try {
      label = normalizeOptionalString(getUserProfileListItem(id).displayName);
    } catch {
      // Human actors can also be channel sender ids; only profile ids resolve here.
      label = undefined;
    }
    userProfileLabelById.set(id, label);
  }
  return { type: actor.type, id, ...(label ? { label } : {}) };
}

export function buildGatewaySessionRow(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  key: string;
  entry?: SessionEntry;
  modelCatalog?: ModelCatalogEntry[];
  now?: number;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  transcriptUsageMaxBytes?: number;
  storeChildSessionsByKey?: Map<string, string[]>;
  rowContext?: SessionListRowContext;
  agentId?: string;
  skipTranscriptUsageFallback?: boolean;
  lightweightListRow?: boolean;
}): GatewaySessionRow {
  const { cfg, storePath, store, key, entry } = params;
  const lightweight = params.lightweightListRow === true;
  const now = params.now ?? Date.now();
  const agentStatus = resolveActiveSessionAgentStatus(entry?.agentStatus, now);
  const observerDigest =
    entry?.observerDigest &&
    // Strictly newer: a run end and restart can share a millisecond, and the
    // prior run's digest must not project onto the replacement run.
    (entry.startedAt === undefined || entry.observerDigest.updatedAt > entry.startedAt)
      ? entry.observerDigest
      : undefined;
  const updatedAt = entry?.updatedAt ?? null;
  const parsed = parseGroupKey(key);
  const deliveryFields = projectSessionDeliveryFields(entry?.delivery);
  const channel = deliveryFields.channel ?? parsed?.channel;
  const subject = entry?.subject;
  const groupChannel = entry?.groupChannel;
  const space = entry?.space;
  const id = parsed?.id;
  const origin = deliveryFields.origin;
  const originLabel = origin?.label;
  const parsedAgent = parseAgentSessionKey(key);
  const isDashboardSession = parsedAgent?.rest.startsWith("dashboard:") === true;
  const isGroupSession = isGroupOrChannelDisplaySession(entry, parsed);
  // A user-assigned label is an explicit rename; it must win over stored
  // channel-derived display names or renames silently vanish on refresh.
  // Group sessions prefer the human chat title (subject/#channel) over the
  // stored compact token displayName (e.g. "slack:g-general").
  const displayName =
    entry?.label ??
    (isGroupSession ? buildGroupDisplayTitle({ subject, groupChannel, space }) : undefined) ??
    entry?.displayName ??
    (isGroupSession && channel
      ? buildGroupDisplayName({
          provider: channel,
          subject,
          groupChannel,
          space,
          id,
          key,
        })
      : undefined) ??
    // Dashboard origin labels identify the authenticated sender. Using them as
    // titles leaks account names into the sidebar while the generated title is pending.
    (isDashboardSession ? undefined : originLabel);
  const sessionAgentId = normalizeAgentId(
    parsedAgent?.agentId ?? params.agentId ?? resolveDefaultAgentId(cfg),
  );
  const skipTranscriptUsage = params.skipTranscriptUsageFallback === true;
  const rowContext = params.rowContext;
  const subagentRun = rowContext
    ? rowContext.subagentRuns.getDisplaySubagentRun(key)
    : getSessionDisplaySubagentRunByChildSessionKey(key);
  const subagentOwner =
    normalizeOptionalString(subagentRun?.controllerSessionKey) ||
    normalizeOptionalString(subagentRun?.requesterSessionKey);
  const liveSubagentRunActive = isSubagentRunLive(subagentRun);
  const persistedSessionStatus = entry?.status;
  const persistedSessionEndedAt = entry?.endedAt;
  const persistedSessionStartedAt = entry?.startedAt;
  const persistedSessionRuntimeMs = entry?.runtimeMs;
  const subagentRunState = subagentRun
    ? liveSubagentRunActive
      ? "active"
      : typeof subagentRun.endedAt === "number" ||
          persistedSessionStatus === "done" ||
          persistedSessionStatus === "failed" ||
          persistedSessionStatus === "killed" ||
          persistedSessionStatus === "timeout" ||
          typeof persistedSessionEndedAt === "number"
        ? "historical"
        : "interrupted"
    : undefined;
  const subagentStatus = subagentRun
    ? liveSubagentRunActive
      ? resolveSubagentSessionStatus(subagentRun)
      : persistedSessionStatus === "running"
        ? undefined
        : (persistedSessionStatus ??
          (typeof subagentRun.endedAt === "number"
            ? resolveSubagentSessionStatus(subagentRun)
            : undefined))
    : undefined;
  const subagentStartedAt = subagentRun
    ? liveSubagentRunActive
      ? getSubagentSessionStartedAt(subagentRun)
      : (persistedSessionStartedAt ?? getSubagentSessionStartedAt(subagentRun))
    : undefined;
  const subagentEndedAt = subagentRun
    ? liveSubagentRunActive
      ? subagentRun.endedAt
      : (persistedSessionEndedAt ?? subagentRun.endedAt)
    : undefined;
  const subagentRuntimeMs = subagentRun
    ? liveSubagentRunActive
      ? resolveSessionRuntimeMs(subagentRun, now)
      : (persistedSessionRuntimeMs ??
        (typeof subagentRun.endedAt === "number"
          ? resolveSessionRuntimeMs(subagentRun, now)
          : undefined))
    : undefined;
  const selectedModel = resolveSessionSelectedModelRef({
    cfg,
    entry,
    agentId: sessionAgentId,
    rowContext,
    allowPluginNormalization: !lightweight,
  });
  const resolvedModel = resolveSessionModelIdentityRef(
    cfg,
    entry,
    sessionAgentId,
    subagentRun?.model,
    { allowPluginNormalization: !lightweight },
  );
  const runtimeModelPresent =
    Boolean(entry?.model?.trim()) || Boolean(entry?.modelProvider?.trim());
  const freshSessionTotalTokens = resolveNonNegativeNumber(resolveFreshSessionTotalTokens(entry));
  const needsTranscriptTotalTokens = freshSessionTotalTokens === undefined;
  const needsTranscriptContextTokens = resolvePositiveNumber(entry?.contextTokens) === undefined;
  const needsTranscriptEstimatedCostUsd =
    !skipTranscriptUsage &&
    resolveEstimatedSessionCostUsd({
      cfg,
      provider: resolvedModel.provider,
      model: resolvedModel.model ?? DEFAULT_MODEL,
      entry,
      rowContext,
    }) === undefined;
  const transcriptUsage =
    !skipTranscriptUsage &&
    (needsTranscriptTotalTokens || needsTranscriptContextTokens || needsTranscriptEstimatedCostUsd)
      ? resolveTranscriptUsageFallback({
          cfg,
          key,
          entry,
          storePath,
          fallbackProvider: resolvedModel.provider,
          fallbackModel: resolvedModel.model ?? DEFAULT_MODEL,
          maxTranscriptBytes: params.transcriptUsageMaxBytes,
          rowContext: params.rowContext,
          agentId: sessionAgentId,
        })
      : null;
  const preferLiveSubagentModelIdentity =
    Boolean(subagentRun?.model?.trim()) && subagentStatus === "running";
  const shouldUseTranscriptModelIdentity =
    runtimeModelPresent &&
    !preferLiveSubagentModelIdentity &&
    (needsTranscriptTotalTokens || needsTranscriptContextTokens);
  const resolvedModelIdentity = {
    provider: resolvedModel.provider,
    model: resolvedModel.model ?? DEFAULT_MODEL,
  };
  const modelIdentity = shouldUseTranscriptModelIdentity
    ? {
        provider: transcriptUsage?.modelProvider ?? resolvedModelIdentity.provider,
        model: transcriptUsage?.model ?? resolvedModelIdentity.model,
      }
    : resolvedModelIdentity;
  const { provider: modelProvider, model } = modelIdentity;
  const totalTokens =
    freshSessionTotalTokens ?? resolveNonNegativeNumber(transcriptUsage?.totalTokens);
  const totalTokensFresh =
    freshSessionTotalTokens !== undefined ||
    (typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0)
      ? true
      : transcriptUsage?.totalTokensFresh === true;
  const goal = entry?.goal
    ? resolveSessionGoalDisplayState(
        {
          goal: entry.goal,
          totalTokens,
          totalTokensFresh,
        },
        now,
        // Session listing is read-only; stale goal baselines are adopted only
        // by goal commands/tools that can persist the first fresh snapshot.
        { adoptFreshBaseline: false },
      )
    : undefined;
  const childSessions = params.storeChildSessionsByKey
    ? mergeChildSessionKeys(
        resolveRuntimeChildSessionKeys(key, now, rowContext?.subagentRuns),
        params.storeChildSessionsByKey.get(key),
      )
    : resolveChildSessionKeys(key, store, now, rowContext?.subagentRuns);
  const compactionCheckpoints = resolveProjectableCompactionCheckpoints(entry);
  const compactionCheckpointCount = Array.isArray(entry?.compactionCheckpoints)
    ? compactionCheckpoints.length
    : undefined;
  const latestCompactionCheckpoint = buildCompactionCheckpointPreview(
    resolveLatestCompactionCheckpoint(compactionCheckpoints),
  );
  const selectedOrRuntimeModelProvider = selectedModel?.provider ?? modelProvider;
  const selectedOrRuntimeModel = selectedModel?.model ?? model;
  const rowModelIdentity = lightweight
    ? { provider: selectedOrRuntimeModelProvider, model: selectedOrRuntimeModel }
    : resolveSessionDisplayModelIdentityRefCached({
        cfg,
        agentId: sessionAgentId,
        provider: selectedOrRuntimeModelProvider,
        model: selectedOrRuntimeModel,
        rowContext: params.rowContext,
      });
  const rowModelProvider = rowModelIdentity.provider;
  const rowModel = rowModelIdentity.model;
  const acpSessionKey = resolveStoredSessionKeyForAgentStore({
    cfg,
    agentId: sessionAgentId,
    sessionKey: key,
  });
  const estimatedCostUsd = lightweight
    ? resolveNonNegativeNumber(entry?.estimatedCostUsd)
    : (resolveEstimatedSessionCostUsd({
        cfg,
        provider: rowModelProvider,
        model: rowModel,
        entry,
        rowContext: params.rowContext,
      }) ?? resolveNonNegativeNumber(transcriptUsage?.estimatedCostUsd));
  const contextTokens = lightweight
    ? (resolvePositiveNumber(entry?.contextTokens) ??
      resolvePositiveNumber(
        resolveContextTokensForModel({
          cfg,
          provider: rowModelProvider,
          model: rowModel,
          allowAsyncLoad: false,
        }),
      ))
    : (resolvePositiveNumber(entry?.contextTokens) ??
      resolvePositiveNumber(transcriptUsage?.contextTokens) ??
      resolvePositiveNumber(
        resolveContextTokensForModel({
          cfg,
          provider: rowModelProvider,
          model: rowModel,
          allowAsyncLoad: false,
        }),
      ));

  let derivedTitle: string | undefined;
  let lastMessagePreview: string | undefined;
  if (entry?.sessionId && (params.includeDerivedTitles || params.includeLastMessage)) {
    const fields = readScopedSessionTitleFieldsFromTranscript({
      agentId: sessionAgentId,
      sessionEntry: entry,
      sessionId: entry.sessionId,
      sessionKey: key,
      storePath,
    });
    if (params.includeDerivedTitles) {
      derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage);
    }
    if (params.includeLastMessage && fields.lastMessagePreview) {
      lastMessagePreview = fields.lastMessagePreview;
    }
  }

  const thinkingProvider = rowModelProvider ?? DEFAULT_PROVIDER;
  const thinkingModel = rowModel ?? DEFAULT_MODEL;
  const thinkingProjection = resolveGatewaySessionThinkingProjectionInternal({
    cfg,
    agentId: sessionAgentId,
    provider: thinkingProvider,
    model: thinkingModel,
    sessionKey: acpSessionKey,
    entry,
    modelCatalog: params.modelCatalog,
    rowContext,
  });
  const fastModeState = resolveFastModeState({
    cfg,
    provider: selectedOrRuntimeModelProvider ?? DEFAULT_PROVIDER,
    model: selectedOrRuntimeModel ?? DEFAULT_MODEL,
    agentId: sessionAgentId,
    sessionEntry:
      entry?.fastMode !== undefined
        ? {
            fastMode: entry.fastMode,
          }
        : undefined,
  });
  const pluginExtensions =
    !lightweight && entry ? projectPluginSessionExtensionsSync({ sessionKey: key, entry }) : [];

  return {
    key,
    visibility: entry ? (entry.visibility ?? "shared") : undefined,
    incognito: entry?.incognito,
    spawnedBy: subagentOwner || entry?.spawnedBy,
    // The live registry controller takes precedence over the persisted spawner.
    controlOwnerSessionKey: subagentOwner || entry?.spawnedBy,
    swarmGroupId: entry?.swarmGroupId,
    spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
    spawnedCwd: entry?.spawnedCwd,
    worktree: entry?.worktree,
    execNode: entry?.execNode,
    execCwd: entry?.execCwd,
    forkedFromParent: sessionEntryForkedFromParent(entry) ? true : undefined,
    spawnDepth: entry?.spawnDepth,
    subagentRole: entry?.subagentRole,
    subagentControlScope: entry?.subagentControlScope,
    createdVia: entry?.createdVia,
    createdActor: projectSessionActor(entry?.createdActor, rowContext?.userProfileLabelById),
    createdAt: entry?.createdAt,
    forkSource: entry?.forkSource,
    previousSessionId: entry?.previousSessionId,
    kind: classifySessionKey(key, entry),
    label: entry?.label,
    category: entry?.category,
    displayName,
    derivedTitle,
    lastMessagePreview,
    channel,
    subject,
    groupChannel,
    space,
    chatType: entry?.chatType,
    origin,
    updatedAt,
    archived: entry?.archivedAt !== undefined,
    archivedAt: entry?.archivedAt,
    archivedBy: projectSessionActor(entry?.archivedBy, rowContext?.userProfileLabelById),
    pinned: entry?.pinnedAt !== undefined,
    pinnedAt: entry?.pinnedAt,
    icon: entry?.icon,
    unread: deriveSessionUnread(entry),
    lastReadAt: entry?.lastReadAt,
    agentStatus,
    observerDigest: observerDigest
      ? {
          runId: observerDigest.runId,
          headline: observerDigest.headline,
          health: observerDigest.health,
          updatedAt: observerDigest.updatedAt,
          revision: observerDigest.revision,
        }
      : undefined,
    lastInteractionAt: entry?.lastInteractionAt,
    lastActivityAt: entry?.lastActivityAt,
    sessionId: entry?.sessionId,
    systemSent: entry?.systemSent,
    abortedLastRun: entry?.abortedLastRun,
    thinkingLevel: thinkingProjection.thinkingLevel,
    thinkingLevels: thinkingProjection.thinkingLevels,
    thinkingOptions: thinkingProjection.thinkingOptions,
    thinkingDefault: thinkingProjection.thinkingDefault,
    fastMode: entry?.fastMode,
    effectiveFastMode: fastModeState.mode,
    effectiveFastModeSource: fastModeState.source,
    fastAutoOnSeconds: fastModeState.fastAutoOnSeconds,
    verboseLevel: entry?.verboseLevel,
    traceLevel: entry?.traceLevel,
    reasoningLevel: entry?.reasoningLevel,
    elevatedLevel: entry?.elevatedLevel,
    sendPolicy: entry?.sendPolicy,
    inputTokens: entry?.inputTokens,
    outputTokens: entry?.outputTokens,
    totalTokens,
    totalTokensFresh,
    goal,
    estimatedCostUsd,
    status: subagentRun ? subagentStatus : entry?.status,
    lastRunError: entry?.lastRunError,
    hasAutomation: sessionHasAutomation(key, cfg) ? true : undefined,
    subagentRunState,
    hasActiveSubagentRun: subagentRun ? liveSubagentRunActive : undefined,
    startedAt: subagentRun ? subagentStartedAt : entry?.startedAt,
    endedAt: subagentRun ? subagentEndedAt : entry?.endedAt,
    runtimeMs: subagentRun ? subagentRuntimeMs : entry?.runtimeMs,
    // Navigation lineage is persisted; runtime control is exposed separately above.
    parentSessionKey: entry?.parentSessionKey,
    childSessions,
    responseUsage: entry?.responseUsage,
    effectiveResponseUsage: resolveEffectiveResponseUsage(
      entry?.responseUsage,
      cfg.messages?.responseUsage,
      channel,
    ),
    queueMode: entry?.queueMode,
    effectiveQueueMode: resolveQueueSettings({
      cfg,
      channel: INTERNAL_MESSAGE_CHANNEL,
      sessionEntry: entry,
    }).mode,
    modelProvider: rowModelProvider,
    model: rowModel,
    modelSelectionLocked: entry?.modelSelectionLocked,
    agentRuntime: thinkingProjection.agentRuntime,
    contextTokens,
    contextBudgetStatus: entry?.contextBudgetStatus,
    deliveryContext: deliveryFields.deliveryContext,
    lastChannel: deliveryFields.lastChannel,
    lastTo: deliveryFields.lastTo,
    lastAccountId: deliveryFields.lastAccountId,
    lastThreadId: deliveryFields.lastThreadId,
    compactionCheckpointCount,
    latestCompactionCheckpoint,
    pluginExtensions: pluginExtensions.length > 0 ? pluginExtensions : undefined,
  };
}

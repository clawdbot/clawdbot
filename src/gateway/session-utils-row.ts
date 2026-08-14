import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { SessionCreatedActor } from "../../packages/gateway-protocol/src/index.js";
import { resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveFastModeState } from "../agents/fast-mode.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveSessionModelIdentityRef } from "../agents/session-model-ref.js";
import {
  countActiveDescendantRuns,
  getSessionDisplaySubagentRunByChildSessionKey,
  getSubagentSessionRuntimeMs,
  getSubagentSessionStartedAt,
  isSubagentRunLive,
  resolveSubagentSessionStatus,
} from "../agents/subagents/registry/subagent-registry-read.js";
import { resolveQueueSettingsCore } from "../auto-reply/reply/queue/settings.js";
import { resolveEffectiveResponseUsage } from "../auto-reply/thinking.js";
import {
  buildGroupDisplayName,
  buildGroupDisplayTitle,
  resolveFreshSessionTotalTokens,
  resolveSessionGoalDisplayState,
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry,
  type SessionEntry,
} from "../config/sessions.js";
import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectPluginSessionExtensionsSync } from "../plugins/host-hook-state.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { classifySessionKind } from "../sessions/classify-session-kind.js";
import { resolveActiveSessionAgentStatus } from "../sessions/session-agent-status.js";
import { projectSessionDeliveryFields } from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { resolveCurrentUserProfileDisplay } from "./current-user-profile-display.js";
import { sessionHasAutomation } from "./session-automation-index.js";
import { sessionClassificationForRow } from "./session-classification.js";
import {
  resolveSessionStoreAgentId,
  resolveStoredSessionKeyForAgentStore,
} from "./session-store-key.js";
import { readSessionTitleFieldsFromTranscript as readScopedSessionTitleFieldsFromTranscript } from "./session-transcript-title-reader.js";
import type {
  SessionActorProfileIdentity,
  SessionListRowContext,
} from "./session-utils-contracts.js";
import {
  buildCompactionCheckpointPreview,
  deriveSessionTitle,
  deriveSessionUnread,
  resolveEstimatedSessionCostUsd,
  resolveLatestCompactionCheckpoint,
  resolvePositiveNumber,
  resolveProjectableCompactionCheckpoints,
  resolveRuntimeChildSessionKeys,
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
import { isGroupOrChannelDisplaySession, parseGroupKey } from "./session-utils-store.js";
import type { GatewaySessionRow } from "./session-utils.types.js";

/** Adds current durable human profile display data without persisting rename-prone metadata. */
export function projectSessionActor(
  actor: SessionEntry["createdActor"],
  userProfileIdentityById: Map<string, SessionActorProfileIdentity | undefined> = new Map(),
): SessionCreatedActor | undefined {
  if (!actor) {
    return undefined;
  }
  const id = normalizeOptionalString(actor.id);
  if (actor.type !== "human" || !id) {
    return { type: actor.type, ...(id ? { id } : {}) };
  }
  let identity = userProfileIdentityById.get(id);
  if (!userProfileIdentityById.has(id)) {
    const display = resolveCurrentUserProfileDisplay(id);
    identity =
      display.kind === "unresolved"
        ? undefined
        : {
            ...(display.label ? { label: display.label } : {}),
            ...(display.hasUploadedAvatar ? { avatarUrl: display.avatarUrl } : {}),
          };
    userProfileIdentityById.set(id, identity);
  }
  return { type: actor.type, id, ...identity };
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
  const sessionKind = classifySessionKind(key, entry);
  // The older Gateway wire kind folds cron/spawn-child into direct.
  const gatewayKind =
    sessionKind === "cron" || sessionKind === "spawn-child" ? "direct" : sessionKind;
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
    parsedAgent?.agentId ?? params.agentId ?? resolveSessionStoreAgentId(cfg, key),
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
  const hasActiveSubagentRun =
    liveSubagentRunActive ||
    (rowContext?.subagentRuns.countActiveDescendantRuns(key) ?? countActiveDescendantRuns(key)) > 0;
  const persistedSessionStatus = entry?.status;
  const persistedSessionEndedAt = entry?.endedAt;
  const persistedSessionStartedAt = entry?.startedAt;
  const persistedSessionRuntimeMs = entry?.runtimeMs;
  const subagentRunState = subagentRun
    ? liveSubagentRunActive
      ? "active"
      : typeof subagentRun.execution.endedAt === "number" ||
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
          (typeof subagentRun.execution.endedAt === "number"
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
      ? subagentRun.execution.endedAt
      : (persistedSessionEndedAt ?? subagentRun.execution.endedAt)
    : undefined;
  const subagentRuntimeMs = subagentRun
    ? liveSubagentRunActive
      ? getSubagentSessionRuntimeMs(subagentRun, now)
      : (persistedSessionRuntimeMs ??
        (typeof subagentRun.execution.endedAt === "number"
          ? getSubagentSessionRuntimeMs(subagentRun, now)
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
  const freshSessionTotalTokens = asNonNegativeFiniteNumber(resolveFreshSessionTotalTokens(entry));
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
  const totalTokens =
    freshSessionTotalTokens ?? asNonNegativeFiniteNumber(transcriptUsage?.totalTokens);
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
          totalTokensVersion: totalTokensFresh ? SESSION_TOTAL_TOKENS_VERSION : undefined,
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
  const selectedModelProvider = selectedModel.provider;
  const selectedModelId = selectedModel.model;
  const rowModelIdentity = lightweight
    ? { provider: selectedModelProvider, model: selectedModelId }
    : resolveSessionDisplayModelIdentityRefCached({
        cfg,
        agentId: sessionAgentId,
        provider: selectedModelProvider,
        model: selectedModelId,
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
    ? asNonNegativeFiniteNumber(entry?.estimatedCostUsd)
    : (resolveEstimatedSessionCostUsd({
        cfg,
        provider: rowModelProvider,
        model: rowModel,
        entry,
        rowContext: params.rowContext,
      }) ?? asNonNegativeFiniteNumber(transcriptUsage?.estimatedCostUsd));
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
      derivedTitle = deriveSessionTitle(entry, fields.firstUserMessage, displayName);
    }
    if (params.includeLastMessage && fields.lastMessagePreview) {
      lastMessagePreview = fields.lastMessagePreview;
    }
  }

  const thinkingProvider = rowModelProvider ?? DEFAULT_PROVIDER;
  const thinkingModel = rowModel ?? DEFAULT_MODEL;
  // Event/list rows must not rediscover plugin-backed configured catalog metadata.
  // Lightweight projections may use an already-active provider policy, but must
  // not fall through to public artifacts that reload the manifest registry.
  const thinkingModelCatalog = params.modelCatalog ?? (lightweight ? [] : undefined);
  const thinkingProjection = resolveGatewaySessionThinkingProjectionInternal({
    cfg,
    agentId: sessionAgentId,
    provider: thinkingProvider,
    model: thinkingModel,
    sessionKey: acpSessionKey,
    entry,
    modelCatalog: thinkingModelCatalog,
    rowContext,
    providerPolicySource: lightweight ? "active" : undefined,
  });
  const fastModeState = resolveFastModeState({
    cfg,
    provider: selectedModelProvider,
    model: selectedModelId,
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
    createdActor: projectSessionActor(entry?.createdActor, rowContext?.userProfileIdentityById),
    createdAt: entry?.createdAt,
    forkSource: entry?.forkSource,
    previousSessionId: entry?.previousSessionId,
    kind: gatewayKind,
    label: entry?.label,
    category: entry?.category,
    boardFace: entry?.boardFace,
    ...sessionClassificationForRow(cfg, key, sessionAgentId, entry),
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
    archivedBy: projectSessionActor(entry?.archivedBy, rowContext?.userProfileIdentityById),
    pinned: entry?.pinnedAt !== undefined,
    pinnedAt: entry?.pinnedAt,
    unread: deriveSessionUnread(entry),
    lastReadAt: entry?.lastReadAt,
    agentStatus,
    observerDigest: observerDigest
      ? {
          ...(observerDigest.agentId ? { agentId: observerDigest.agentId } : {}),
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
    restartRecoveryStatus: (entry as InternalSessionEntry | undefined)?.mainRestartRecovery
      ?.tombstone
      ? "tombstoned"
      : undefined,
    thinkingLevel: thinkingProjection.thinkingLevel,
    thinkingLevels: thinkingProjection.thinkingLevels,
    thinkingOptions: thinkingProjection.thinkingOptions,
    thinkingDefault: thinkingProjection.thinkingDefault,
    fastMode: entry?.fastMode,
    toolOverrides: entry?.toolOverrides,
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
    hasAutomation: sessionHasAutomation(key, cfg, sessionAgentId) ? true : undefined,
    subagentRunState,
    hasActiveSubagentRun: subagentRun || hasActiveSubagentRun ? hasActiveSubagentRun : undefined,
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
    effectiveQueueMode: resolveQueueSettingsCore({
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

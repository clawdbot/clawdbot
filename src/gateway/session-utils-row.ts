import { createHash } from "node:crypto";
import { asNonNegativeFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { SESSION_PARTICIPANT_LIMIT } from "../../packages/gateway-protocol/src/schema/session-participant.js";
import { resolveAuthoredModelContextTokens } from "../agents/context-resolution.js";
import { resolveContextTokensForModel } from "../agents/context.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../agents/defaults.js";
import { resolveFastModeState } from "../agents/fast-mode.js";
import { findModelCatalogEntry, type ModelCatalogEntry } from "../agents/model-catalog.js";
import { resolveModelContextWindowProfile } from "../agents/model-context-window.js";
import { resolveSelectedAndActiveModel } from "../auto-reply/model-runtime.js";
import { resolveQueueSettingsCore } from "../auto-reply/reply/queue/settings.js";
import { resolveEffectiveResponseUsage } from "../auto-reply/thinking.js";
import {
  resolveFreshSessionTotalTokens,
  resolveProjectedSessionContextTokens,
  resolveProjectedSessionContextBudgetStatus,
  SESSION_TOTAL_TOKENS_VERSION,
  type InternalSessionEntry,
  type SessionEntry,
} from "../config/sessions.js";
import { resolveSessionModelOverrideSource } from "../config/sessions/model-override-provenance.js";
import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import {
  MAX_SESSION_PARTICIPANTS,
  sessionCreatorProfileId,
} from "../config/sessions/session-entry-provenance.js";
import { isPinnableSessionEntry } from "../config/sessions/session-pin-policy.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { projectPluginSessionExtensionsSync } from "../plugins/host-hook-state.js";
import { resolveActiveSessionAgentStatus } from "../sessions/session-agent-status.js";
import { getSessionRepositoryWorkspaceStore } from "../state/session-repository-workspaces.js";
import { resolveActiveFallbackState } from "../status/fallback-notice-state.js";
import { projectSessionDeliveryFields } from "../utils/delivery-context.shared.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../utils/message-channel-constants.js";
import { buildControlUiChannelAvatarUrl } from "./control-ui-contract.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { sessionHasAutomation } from "./session-automation-index.js";
import { sessionClassificationForRow } from "./session-classification.js";
import {
  projectSessionActor,
  projectSessionOwner,
  projectSessionParticipants,
} from "./session-identity-projection.js";
import { isSessionPermissionChangePending } from "./session-permission-change.js";
import { resolveStoredSessionKeyForAgentStore } from "./session-store-key.js";
import { buildSessionSwarmSummary } from "./session-swarm-summary.js";
import { readSessionTerminalModelFromTranscript } from "./session-transcript-readers.js";
import { readSessionTitleFieldsFromTranscript as readScopedSessionTitleFieldsFromTranscript } from "./session-transcript-title-reader.js";
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
} from "./session-utils-core.js";
import {
  resolveGatewaySessionDisplayName,
  resolveGatewaySessionKind,
  projectGatewaySessionRunState,
  resolveGatewaySessionGoal,
} from "./session-utils-display.js";
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
import { parseGroupKey } from "./session-utils-store.js";
import type { GatewaySessionRow, SessionListModelCatalog } from "./session-utils.types.js";
import { projectWorkerPlacementAgentRuntime } from "./worker-environments/placement-session-runtime.js";

/** Opaque cache-busting revision for the channel-avatar route; never leaks the reference. */
function channelAvatarRevision(reference: string): string {
  return createHash("sha256").update(reference).digest("base64url").slice(0, 12);
}

export function buildGatewaySessionRow(params: {
  cfg: OpenClawConfig;
  storePath: string;
  store: Record<string, SessionEntry>;
  key: string;
  entry?: InternalSessionEntry;
  modelCatalog?: SessionListModelCatalog | ModelCatalogEntry[];
  now?: number;
  includeDerivedTitles?: boolean;
  includeLastMessage?: boolean;
  transcriptUsageMaxBytes?: number;
  storeChildSessionsByKey?: Map<string, string[]>;
  rowContext?: SessionListRowContext;
  configuredAgentIds?: ReadonlySet<string>;
  agentId: string;
  skipTranscriptUsageFallback?: boolean;
  lightweightListRow?: boolean;
  includeSwarmChildren?: boolean;
}): GatewaySessionRow {
  const { cfg, storePath, store, key, entry } = params;
  const lightweight = params.lightweightListRow === true;
  const now = params.now ?? Date.now();
  const agentStatus = resolveActiveSessionAgentStatus(entry?.agentStatus, now);
  const owner = projectSessionOwner(
    entry,
    params.rowContext?.userProfileIdentityById,
    cfg,
    params.configuredAgentIds,
  );
  const participants = projectSessionParticipants(
    entry,
    params.rowContext?.userProfileIdentityById,
    cfg,
  );
  if (owner?.actor.identity) {
    participants.delete(JSON.stringify(owner.actor.identity));
  }
  const observerDigest =
    entry?.observerDigest &&
    // Strictly newer: a run end and restart can share a millisecond, and the
    // prior run's digest must not project onto the replacement run.
    (entry.startedAt === undefined || entry.observerDigest.updatedAt > entry.startedAt)
      ? entry.observerDigest
      : undefined;
  const updatedAt = entry?.updatedAt ?? null;
  const parsed = parseGroupKey(key);
  const gatewayKind = resolveGatewaySessionKind(key, entry);
  const deliveryFields = projectSessionDeliveryFields(entry?.delivery);
  const channel = deliveryFields.channel ?? parsed?.channel;
  const subject = entry?.subject;
  const groupChannel = entry?.groupChannel;
  const space = entry?.space;
  const storedOrigin = deliveryFields.origin;
  const avatar = normalizeOptionalString(storedOrigin?.avatar);
  const origin = storedOrigin
    ? (({ avatar: _avatar, ...safeOrigin }) => safeOrigin)(storedOrigin)
    : undefined;
  const controlUiBasePath = normalizeControlUiBasePath(cfg.gateway?.controlUi?.basePath);
  const channelAvatarUrl = avatar
    ? buildControlUiChannelAvatarUrl(controlUiBasePath, key, channelAvatarRevision(avatar))
    : undefined;
  const displayName = resolveGatewaySessionDisplayName(key, entry);
  const sessionAgentId = params.agentId;
  const skipTranscriptUsage = params.skipTranscriptUsageFallback === true;
  const rowContext = params.rowContext;
  const {
    subagentRun,
    subagentOwner,
    fields: runFields,
  } = projectGatewaySessionRunState({ key, entry, now, rowContext });
  const selectedModel = resolveSessionSelectedModelRef({
    cfg,
    sessionKey: key,
    entry,
    agentId: sessionAgentId,
    rowContext,
    allowPluginNormalization: !lightweight,
  });
  const freshSessionTotalTokens = asNonNegativeFiniteNumber(resolveFreshSessionTotalTokens(entry));
  const transcriptUsage = !skipTranscriptUsage
    ? resolveTranscriptUsageFallback({
        cfg,
        key,
        entry,
        storePath,
        freshTotalTokens: freshSessionTotalTokens,
        fallbackModelRef: subagentRun?.model,
        allowPluginNormalization: !lightweight,
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
  const goal = resolveGatewaySessionGoal(entry, now, {
    totalTokens,
    totalTokensFresh,
    totalTokensVersion: totalTokensFresh ? SESSION_TOTAL_TOKENS_VERSION : undefined,
  });
  const childSessions = params.storeChildSessionsByKey
    ? mergeChildSessionKeys(
        resolveRuntimeChildSessionKeys(key, now, rowContext?.subagentRuns),
        params.storeChildSessionsByKey.get(key),
      )
    : resolveChildSessionKeys(key, store, now, rowContext?.subagentRuns);
  const pinnedAt =
    entry?.pinnedAt !== undefined && isPinnableSessionEntry(key, entry)
      ? entry.pinnedAt
      : undefined;
  const compactionCheckpoints = resolveProjectableCompactionCheckpoints(entry);
  const compactionCheckpointCount = Array.isArray(entry?.compactionCheckpoints)
    ? compactionCheckpoints.length
    : undefined;
  const latestCompactionCheckpoint = buildCompactionCheckpointPreview(
    resolveLatestCompactionCheckpoint(compactionCheckpoints),
  );
  const rowModelProvider = selectedModel.provider;
  const rowModel = selectedModel.model;
  const rowModelIdentity = resolveSessionDisplayModelIdentityRefCached({
    cfg,
    provider: rowModelProvider,
    model: rowModel,
    rowContext: params.rowContext,
  });
  // Display aliases do not change the selected route's catalog or runtime policy.
  const completedModel =
    entry?.status === "done" && entry.lastRunId && entry.fallbackNotice
      ? readSessionTerminalModelFromTranscript(
          { agentId: sessionAgentId, sessionKey: key, sessionId: entry.sessionId, storePath },
          entry.lastRunId,
        )
      : undefined;
  const runtimeModels = resolveSelectedAndActiveModel({
    selectedProvider: rowModelProvider,
    selectedModel: rowModel,
    sessionEntry: completedModel ?? entry,
  });
  const activeFallback = resolveActiveFallbackState({
    selectedModelRef: runtimeModels.selected.label,
    activeModelRef: runtimeModels.active.label,
    config: cfg,
    state: entry,
  });
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
  // Entries and provider policy must stay bound to the same prepared agent owner;
  // the Gateway startup registry can contain a different set of plugins.
  const preparedCatalog =
    params.modelCatalog instanceof Map ? params.modelCatalog.get(sessionAgentId) : undefined;
  const rowModelCatalog =
    params.modelCatalog instanceof Map ? preparedCatalog?.entries : params.modelCatalog;
  // Event/list rows must not rediscover plugin-backed configured catalog metadata.
  // Lightweight projections may use an already-active provider policy, but must
  // not fall through to public artifacts that reload the manifest registry.
  const thinkingModelCatalog = rowModelCatalog ?? (lightweight ? [] : undefined);
  const thinkingProjection = resolveGatewaySessionThinkingProjectionInternal({
    cfg,
    agentId: sessionAgentId,
    provider: thinkingProvider,
    model: thinkingModel,
    sessionKey: acpSessionKey,
    entry,
    modelCatalog: thinkingModelCatalog,
    rowContext,
    providerPolicySource: preparedCatalog?.pluginRegistry ?? (lightweight ? "active" : undefined),
  });
  const catalogEntry =
    rowModelCatalog && rowModelProvider && rowModel
      ? findModelCatalogEntry(rowModelCatalog, {
          provider: rowModelProvider,
          modelId: rowModel,
        })
      : undefined;
  const contextWindowProfile = resolveModelContextWindowProfile({
    catalogEntry,
    selected: entry?.contextWindow,
  });
  const resolvedModelContextTokens = resolvePositiveNumber(
    resolveContextTokensForModel({
      cfg,
      provider: rowModelProvider,
      model: rowModel,
      modelContextTokens: catalogEntry?.contextTokens,
      modelContextWindow: contextWindowProfile.contextTokens,
      allowAsyncLoad: false,
    }),
  );
  const resolvedCurrentContextTokens = contextWindowProfile.contextTokens
    ? Math.min(
        resolvedModelContextTokens ?? contextWindowProfile.contextTokens,
        contextWindowProfile.contextTokens,
      )
    : resolvedModelContextTokens;
  const authoredContextTokens = resolvePositiveNumber(
    resolveAuthoredModelContextTokens({
      cfg,
      provider: rowModelProvider,
      model: rowModel,
    }),
  );
  const contextTokens = resolveProjectedSessionContextTokens({
    entry,
    provider: rowModelProvider,
    model: rowModel,
    agentHarnessId: thinkingProjection.agentRuntime.id,
    resolvedContextTokens: resolvedCurrentContextTokens,
    authoredContextTokens,
  });
  const fastModeState = resolveFastModeState({
    cfg,
    provider: rowModelProvider,
    model: rowModel,
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
  const repositoryWorkspace = entry?.repositoryWorkspaceId
    ? getSessionRepositoryWorkspaceStore().get(entry.repositoryWorkspaceId)
    : undefined;
  const repository =
    repositoryWorkspace?.agentId === sessionAgentId && repositoryWorkspace.sessionKey === key
      ? {
          url: repositoryWorkspace.url,
          ...(repositoryWorkspace.requestedRef ? { ref: repositoryWorkspace.requestedRef } : {}),
          branch: repositoryWorkspace.branch,
        }
      : undefined;

  const swarm = buildSessionSwarmSummary(
    rowContext?.subagentRuns.swarmRunsByRequesterSessionKey.get(key) ?? [],
    key,
    sessionAgentId,
    { includeChildren: params.includeSwarmChildren },
  );
  return {
    key,
    // Presence records a completed registry projection; event merges may clear only that fact.
    ...(rowContext ? { swarm } : {}),
    visibility: entry ? (entry.visibility ?? "shared") : undefined,
    incognito: entry?.incognito,
    spawnedBy: subagentOwner || entry?.spawnedBy,
    // The live registry controller takes precedence over the persisted spawner.
    controlOwnerSessionKey: subagentOwner || entry?.spawnedBy,
    swarmGroupId: entry?.swarmGroupId,
    spawnedWorkspaceDir: entry?.spawnedWorkspaceDir,
    spawnedCwd: entry?.spawnedCwd,
    permissionMode: entry?.permissionMode,
    permissionModePending: isSessionPermissionChangePending(entry?.sessionId),
    ...(entry?.permissionMode !== undefined && entry.sessionRoot !== undefined
      ? { sessionRoot: entry.sessionRoot }
      : {}),
    worktree: entry?.worktree,
    repositoryWorkspaceId: entry?.repositoryWorkspaceId,
    ...(repository ? { repository } : {}),
    execNode: entry?.execNode,
    execCwd: entry?.execCwd,
    forkedFromParent: sessionEntryForkedFromParent(entry) ? true : undefined,
    spawnDepth: entry?.spawnDepth,
    subagentRole: entry?.subagentRole,
    subagentControlScope: entry?.subagentControlScope,
    createdVia: entry?.createdVia,
    createdActor: projectSessionActor(
      entry?.createdActor,
      rowContext?.userProfileIdentityById,
      cfg,
      Boolean(sessionCreatorProfileId(entry?.createdActor)),
    ),
    owner,
    // Keep the released v4 summary stable; expanded identities are additive for newer clients.
    participants: participants.size
      ? [...participants.values()].slice(0, SESSION_PARTICIPANT_LIMIT)
      : undefined,
    expandedParticipants: participants.size
      ? [...participants.values()].slice(0, MAX_SESSION_PARTICIPANTS)
      : undefined,
    participantCount: participants.size || undefined,
    createdAt: entry?.createdAt,
    forkSource: entry?.forkSource,
    previousSessionId: entry?.previousSessionId,
    kind: gatewayKind,
    label: entry?.label,
    icon: entry?.icon,
    color: entry?.color,
    channelAvatarUrl,
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
    archivedBy: projectSessionActor(entry?.archivedBy, rowContext?.userProfileIdentityById, cfg),
    archiveReason: entry?.archiveReason,
    pinned: pinnedAt !== undefined,
    pinnedAt,
    unread: deriveSessionUnread(entry),
    lastReadAt: entry?.lastReadAt,
    markedUnreadAt: entry?.markedUnreadAt,
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
    contextWindow: contextWindowProfile.contextWindow,
    contextWindows: contextWindowProfile.contextWindows,
    contextWindowDefault: contextWindowProfile.contextWindowDefault,
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
    ...runFields,
    lastRunError: entry?.lastRunError,
    lastRunId: entry?.lastRunId,
    hasAutomation: sessionHasAutomation(key, cfg, sessionAgentId) ? true : undefined,
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
    modelProvider: rowModelIdentity.provider,
    model: rowModelIdentity.model,
    activeModelProvider: activeFallback.active ? runtimeModels.active.provider : undefined,
    activeModel: activeFallback.active ? runtimeModels.active.model : undefined,
    modelOverrideSource: resolveSessionModelOverrideSource(entry),
    modelSelectionLocked: entry?.modelSelectionLocked,
    agentRuntime: projectWorkerPlacementAgentRuntime(thinkingProjection.agentRuntime),
    contextTokens,
    contextBudgetStatus: resolveProjectedSessionContextBudgetStatus({
      entry,
      provider: rowModelProvider,
      model: rowModel,
      contextTokens,
    }),
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

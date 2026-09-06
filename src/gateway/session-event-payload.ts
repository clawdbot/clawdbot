import { sessionEntryForkedFromParent } from "../config/sessions/session-entry-lineage.js";
import type { AgentEventPayload } from "../infra/agent-events.js";
import {
  deriveGatewaySessionLifecycleProjectionPatch,
  isStaleLifecycleEventForSession,
} from "./session-lifecycle-state.js";
import type { GatewaySessionRow } from "./session-utils.js";

/**
 * Project a catalog-less session row for websocket merge events.
 * Picker metadata comes from catalog-backed list/patch responses; emitting a
 * locally reconstructed subset here would replace richer client state.
 */
export function buildGatewaySessionEventFields(params: {
  sessionRow: GatewaySessionRow;
  agentId?: string;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
  status?: GatewaySessionRow["status"];
  hasActiveRun?: boolean;
  activeRunIds?: string[] | null;
}): Record<string, unknown> {
  const { sessionRow } = params;
  const omitUnscopedGlobalGoal = sessionRow.key === "global" && !params.agentId;
  const omitUnscopedSwarm =
    (sessionRow.key === "global" || sessionRow.key === "unknown") && !params.agentId;
  return {
    updatedAt: sessionRow.updatedAt ?? undefined,
    sessionId: sessionRow.sessionId,
    createdActor: sessionRow.createdActor ?? null,
    owner: sessionRow.owner ?? null,
    participants: sessionRow.participants ?? [],
    participantCount: sessionRow.participantCount ?? 0,
    kind: sessionRow.kind,
    visibility: sessionRow.visibility,
    channel: sessionRow.channel,
    subject: sessionRow.subject,
    groupChannel: sessionRow.groupChannel,
    space: sessionRow.space,
    chatType: sessionRow.chatType,
    origin: sessionRow.origin,
    archived: sessionRow.archived ?? false,
    archivedAt: sessionRow.archivedAt ?? null,
    archivedBy: sessionRow.archivedBy ?? null,
    archiveReason: sessionRow.archiveReason ?? null,
    pinned: sessionRow.pinned ?? false,
    pinnedAt: sessionRow.pinnedAt ?? null,
    unread: sessionRow.unread ?? false,
    lastReadAt: sessionRow.lastReadAt,
    markedUnreadAt: sessionRow.markedUnreadAt ?? null,
    agentStatus: sessionRow.agentStatus ?? null,
    observerDigest: sessionRow.observerDigest ?? null,
    lastActivityAt: sessionRow.lastActivityAt,
    spawnedBy: sessionRow.spawnedBy,
    controlOwnerSessionKey: sessionRow.controlOwnerSessionKey ?? null,
    swarmGroupId: sessionRow.swarmGroupId,
    ...(!Object.hasOwn(sessionRow, "swarm") || omitUnscopedSwarm
      ? {}
      : {
          swarm: sessionRow.swarm
            ? {
                ...sessionRow.swarm,
                groups: sessionRow.swarm.groups.map(({ children: _children, ...counts }) => counts),
              }
            : null,
        }),
    spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
    spawnedCwd: sessionRow.spawnedCwd,
    permissionMode: sessionRow.permissionMode ?? null,
    permissionModePending: sessionRow.permissionModePending ?? false,
    ...(sessionRow.permissionMode !== undefined && sessionRow.sessionRoot !== undefined
      ? { sessionRoot: sessionRow.sessionRoot }
      : {}),
    forkedFromParent: sessionEntryForkedFromParent(sessionRow) ? true : undefined,
    spawnDepth: sessionRow.spawnDepth,
    subagentRole: sessionRow.subagentRole,
    subagentControlScope: sessionRow.subagentControlScope,
    createdVia: sessionRow.createdVia,
    createdAt: sessionRow.createdAt,
    forkSource: sessionRow.forkSource,
    previousSessionId: sessionRow.previousSessionId,
    label: params.label ?? sessionRow.label ?? null,
    icon: sessionRow.icon ?? null,
    // Explicit null so subscribed clients drop a cleared color during merge-reconcile.
    color: sessionRow.color ?? null,
    channelAvatarUrl: sessionRow.channelAvatarUrl ?? null,
    // Explicit null so subscribed clients drop a cleared category during merge-reconcile.
    category: sessionRow.category ?? null,
    displayName: params.displayName ?? sessionRow.displayName ?? null,
    deliveryContext: sessionRow.deliveryContext,
    parentSessionKey: params.parentSessionKey ?? sessionRow.parentSessionKey,
    childSessions: sessionRow.childSessions,
    // Explicit null lets subscribed clients clear an override during merge-reconcile.
    thinkingLevel: sessionRow.thinkingLevel ?? null,
    fastMode: sessionRow.fastMode,
    effectiveFastMode: sessionRow.effectiveFastMode,
    effectiveFastModeSource: sessionRow.effectiveFastModeSource,
    fastAutoOnSeconds: sessionRow.fastAutoOnSeconds,
    toolOverrides: sessionRow.toolOverrides ?? null,
    verboseLevel: sessionRow.verboseLevel,
    traceLevel: sessionRow.traceLevel,
    reasoningLevel: sessionRow.reasoningLevel,
    elevatedLevel: sessionRow.elevatedLevel,
    sendPolicy: sessionRow.sendPolicy,
    systemSent: sessionRow.systemSent,
    abortedLastRun: sessionRow.abortedLastRun,
    restartRecoveryStatus: sessionRow.restartRecoveryStatus ?? null,
    inputTokens: sessionRow.inputTokens,
    outputTokens: sessionRow.outputTokens,
    lastChannel: sessionRow.lastChannel,
    lastTo: sessionRow.lastTo,
    lastAccountId: sessionRow.lastAccountId,
    lastThreadId: sessionRow.lastThreadId,
    totalTokens: sessionRow.totalTokens,
    totalTokensFresh: sessionRow.totalTokensFresh,
    ...(omitUnscopedGlobalGoal ? {} : { goal: sessionRow.goal ?? null }),
    contextTokens: sessionRow.contextTokens,
    estimatedCostUsd: sessionRow.estimatedCostUsd,
    responseUsage: sessionRow.responseUsage,
    effectiveResponseUsage: sessionRow.effectiveResponseUsage,
    modelProvider: sessionRow.modelProvider,
    model: sessionRow.model,
    activeModelProvider: sessionRow.activeModelProvider ?? null,
    activeModel: sessionRow.activeModel ?? null,
    modelOverrideSource: sessionRow.modelOverrideSource,
    agentRuntime: sessionRow.agentRuntime,
    status: params.status ?? sessionRow.status,
    // Explicit null lets subscribed clients clear the previous run's failure reason.
    lastRunError: sessionRow.lastRunError ?? null,
    // Explicit null lets a newer start evict the previous terminal run identity.
    lastRunId: sessionRow.lastRunId ?? null,
    // Explicit false lets subscribed clients drop the flag during merge-reconcile.
    hasAutomation: sessionRow.hasAutomation ?? false,
    ...(params.hasActiveRun === undefined ? {} : { hasActiveRun: params.hasActiveRun }),
    ...(params.activeRunIds === undefined ? {} : { activeRunIds: params.activeRunIds }),
    startedAt: sessionRow.startedAt,
    endedAt: sessionRow.endedAt,
    runtimeMs: sessionRow.runtimeMs,
    compactionCheckpointCount: sessionRow.compactionCheckpointCount,
    latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
    pluginExtensions: sessionRow.pluginExtensions,
  };
}

export function buildGatewaySessionSnapshot(params: {
  sessionRow: GatewaySessionRow | null | undefined;
  agentId?: string;
  includeSession?: boolean;
  lifecycle?: boolean;
  event?: AgentEventPayload;
  lifecycleRunId?: string;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
  activeRunState?: { active: boolean; runIds?: string[]; status?: "queued" } | null;
  status?: GatewaySessionRow["status"];
}): Record<string, unknown> {
  const { event, sessionRow: storedRow } = params;
  if (!storedRow) {
    return {};
  }
  const lifecycleRow = event
    ? { ...storedRow, updatedAt: storedRow.updatedAt ?? undefined }
    : undefined;
  const patch =
    event &&
    !isStaleLifecycleEventForSession({
      owningSessionId: event.sessionId,
      currentSessionId: storedRow.sessionId,
      eventRunId: event.runId,
      currentRunId: params.lifecycleRunId,
      eventStartedAt: event.data?.startedAt,
      currentStartedAt: storedRow.startedAt,
    })
      ? deriveGatewaySessionLifecycleProjectionPatch({ entry: lifecycleRow, event })
      : {};
  const sessionRow = { ...storedRow, ...patch };
  for (const key of ["thinkingLevels", "thinkingOptions", "thinkingDefault"] as const) {
    delete sessionRow[key];
  }
  if (params.lifecycle && sessionRow.totalTokensFresh !== true) {
    delete sessionRow.totalTokens;
    delete sessionRow.totalTokensFresh;
    delete sessionRow.contextTokens;
    delete sessionRow.estimatedCostUsd;
  }
  // Accepted terminal events outrank retained cleanup liveness; otherwise the
  // active owner, not a stale persisted row, supplies current run status.
  const activeStatus = params.activeRunState?.active
    ? (params.activeRunState.status ?? "running")
    : undefined;
  const status = params.status ?? patch.status ?? activeStatus;
  const eventFields = buildGatewaySessionEventFields({
    sessionRow,
    agentId: params.agentId,
    label: params.label,
    displayName: params.displayName,
    parentSessionKey: params.parentSessionKey,
    status,
    hasActiveRun: params.activeRunState?.active,
    // Presence means an exact set; null clears stale IDs when only liveness is known.
    activeRunIds: params.activeRunState ? (params.activeRunState.runIds ?? null) : undefined,
  });
  if (params.lifecycle) {
    // Lifecycle snapshots cannot replace selection metadata or clear an active fallback.
    for (const field of [
      "modelProvider",
      "model",
      "activeModelProvider",
      "activeModel",
      "modelOverrideSource",
      "agentRuntime",
    ] as const) {
      delete sessionRow[field];
      delete eventFields[field];
    }
  }
  const session: Record<string, unknown> | undefined = params.includeSession
    ? Object.assign(
        sessionRow,
        Object.fromEntries(Object.entries(eventFields).filter(([, value]) => value !== undefined)),
      )
    : undefined;
  if (session && sessionRow.key === "global" && !params.agentId) {
    delete session.goal;
  }
  if (session && (sessionRow.key === "global" || sessionRow.key === "unknown") && !params.agentId) {
    delete session.swarm;
  }
  return {
    ...(session ? { session } : {}),
    ...eventFields,
    subagentRunState: sessionRow.subagentRunState,
    hasActiveSubagentRun: sessionRow.hasActiveSubagentRun,
  };
}

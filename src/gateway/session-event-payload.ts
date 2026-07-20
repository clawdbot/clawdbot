import type { GatewaySessionRow } from "./session-utils.js";

/**
 * Project a catalog-less session row for websocket merge events.
 * Picker metadata comes from catalog-backed list/patch responses; emitting a
 * locally reconstructed subset here would replace richer client state.
 */
export function buildGatewaySessionEventRow(sessionRow: GatewaySessionRow): GatewaySessionRow {
  const session = { ...sessionRow };
  delete session.thinkingLevels;
  delete session.thinkingOptions;
  delete session.thinkingDefault;
  return session;
}

export function buildGatewaySessionEventFields(params: {
  sessionRow: GatewaySessionRow;
  agentId?: string;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
  hasActiveRun?: boolean;
  activeRunIds?: string[];
}): Record<string, unknown> {
  const { sessionRow } = params;
  const omitUnscopedGlobalGoal = sessionRow.key === "global" && !params.agentId;
  return {
    updatedAt: sessionRow.updatedAt ?? undefined,
    sessionId: sessionRow.sessionId,
    kind: sessionRow.kind,
    channel: sessionRow.channel,
    subject: sessionRow.subject,
    groupChannel: sessionRow.groupChannel,
    space: sessionRow.space,
    chatType: sessionRow.chatType,
    origin: sessionRow.origin,
    archived: sessionRow.archived ?? false,
    archivedAt: sessionRow.archivedAt ?? null,
    pinned: sessionRow.pinned ?? false,
    pinnedAt: sessionRow.pinnedAt ?? null,
    icon: sessionRow.icon ?? null,
    unread: sessionRow.unread ?? false,
    lastReadAt: sessionRow.lastReadAt,
    agentStatus: sessionRow.agentStatus ?? null,
    lastActivityAt: sessionRow.lastActivityAt,
    spawnedBy: sessionRow.spawnedBy,
    swarmGroupId: sessionRow.swarmGroupId,
    spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
    spawnedCwd: sessionRow.spawnedCwd,
    forkedFromParent: sessionRow.forkedFromParent,
    spawnDepth: sessionRow.spawnDepth,
    subagentRole: sessionRow.subagentRole,
    subagentControlScope: sessionRow.subagentControlScope,
    label: params.label ?? sessionRow.label ?? null,
    // Explicit null so subscribed clients drop a cleared category during merge-reconcile.
    category: sessionRow.category ?? null,
    displayName: params.displayName ?? sessionRow.displayName ?? null,
    deliveryContext: sessionRow.deliveryContext,
    parentSessionKey: params.parentSessionKey ?? sessionRow.parentSessionKey,
    childSessions: sessionRow.childSessions,
    // Explicit null lets subscribed clients clear an override during merge-reconcile.
    thinkingLevel: sessionRow.thinkingLevel ?? null,
    fastMode: sessionRow.fastMode,
    verboseLevel: sessionRow.verboseLevel,
    reasoningLevel: sessionRow.reasoningLevel,
    elevatedLevel: sessionRow.elevatedLevel,
    sendPolicy: sessionRow.sendPolicy,
    systemSent: sessionRow.systemSent,
    abortedLastRun: sessionRow.abortedLastRun,
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
    agentRuntime: sessionRow.agentRuntime,
    status: sessionRow.status,
    // Explicit null lets subscribed clients clear the previous run's failure reason.
    lastRunError: sessionRow.lastRunError ?? null,
    // Explicit false lets subscribed clients drop the flag during merge-reconcile.
    hasAutomation: sessionRow.hasAutomation ?? false,
    ...(params.hasActiveRun === undefined ? {} : { hasActiveRun: params.hasActiveRun }),
    ...(params.activeRunIds === undefined ? {} : { activeRunIds: params.activeRunIds }),
    startedAt: sessionRow.startedAt,
    endedAt: sessionRow.endedAt,
    runtimeMs: sessionRow.runtimeMs,
    compactionCheckpointCount: sessionRow.compactionCheckpointCount,
    latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
  };
}

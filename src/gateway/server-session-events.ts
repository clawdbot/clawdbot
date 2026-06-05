// Gateway session event broadcaster.
// Projects transcript and lifecycle updates to websocket subscribers.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { SessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type { SessionTranscriptUpdate } from "../sessions/transcript-events.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { resolveSessionKeyForTranscriptFile } from "./session-transcript-key.js";
import {
  attachOpenClawTranscriptMeta,
  loadGatewaySessionRow,
  loadSessionEntry,
  readSessionMessageCountAsync,
  type GatewaySessionRow,
} from "./session-utils.js";

type SessionEventSubscribers = Pick<SessionEventSubscriberRegistry, "getAll">;
type SessionMessageSubscribers = Pick<SessionMessageSubscriberRegistry, "get">;

function resolveSessionMessageBroadcastKeys(sessionKey: string, agentId?: string): string[] {
  // Global sessions can be subscribed through either the raw global key or the
  // default-agent scoped key; non-default agent global sessions stay scoped.
  const normalizedAgentId = normalizeOptionalString(agentId);
  if (sessionKey === "global") {
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(getRuntimeConfig()));
    if (normalizedAgentId) {
      const scopedKey = `agent:${normalizeAgentId(normalizedAgentId)}:global`;
      return normalizeAgentId(normalizedAgentId) === defaultAgentId
        ? [scopedKey, sessionKey]
        : [scopedKey];
    }
    return [`agent:${defaultAgentId}:global`, sessionKey];
  }
  return [sessionKey];
}

function buildGatewaySessionSnapshot(params: {
  sessionRow: GatewaySessionRow | null | undefined;
  agentId?: string;
  includeSession?: boolean;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
}): Record<string, unknown> {
  const { sessionRow } = params;
  if (!sessionRow) {
    return {};
  }
  const omitUnscopedGlobalGoal = sessionRow.key === "global" && !params.agentId;
  // The unscoped global row hides goal state to avoid presenting one agent's
  // scoped goal as the global/default session goal.
  const session = params.includeSession ? { ...sessionRow } : undefined;
  if (session && omitUnscopedGlobalGoal) {
    delete session.goal;
  }
  return {
    ...(session ? { session } : {}),
    updatedAt: sessionRow.updatedAt ?? undefined,
    sessionId: sessionRow.sessionId,
    kind: sessionRow.kind,
    channel: sessionRow.channel,
    subject: sessionRow.subject,
    groupChannel: sessionRow.groupChannel,
    space: sessionRow.space,
    chatType: sessionRow.chatType,
    origin: sessionRow.origin,
    spawnedBy: sessionRow.spawnedBy,
    spawnedWorkspaceDir: sessionRow.spawnedWorkspaceDir,
    spawnedCwd: sessionRow.spawnedCwd,
    forkedFromParent: sessionRow.forkedFromParent,
    spawnDepth: sessionRow.spawnDepth,
    subagentRole: sessionRow.subagentRole,
    subagentControlScope: sessionRow.subagentControlScope,
    label: params.label ?? sessionRow.label,
    displayName: params.displayName ?? sessionRow.displayName,
    deliveryContext: sessionRow.deliveryContext,
    parentSessionKey: params.parentSessionKey ?? sessionRow.parentSessionKey,
    childSessions: sessionRow.childSessions,
    thinkingLevel: sessionRow.thinkingLevel,
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
    modelProvider: sessionRow.modelProvider,
    model: sessionRow.model,
    status: sessionRow.status,
    subagentRunState: sessionRow.subagentRunState,
    hasActiveSubagentRun: sessionRow.hasActiveSubagentRun,
    startedAt: sessionRow.startedAt,
    endedAt: sessionRow.endedAt,
    runtimeMs: sessionRow.runtimeMs,
    compactionCheckpointCount: sessionRow.compactionCheckpointCount,
    latestCompactionCheckpoint: sessionRow.latestCompactionCheckpoint,
  };
}

/** Creates a serialized transcript-update broadcaster for session websocket clients. */
export function createTranscriptUpdateBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  sessionMessageSubscribers: SessionMessageSubscribers;
}) {
  let broadcastQueue = Promise.resolve();
  return (update: SessionTranscriptUpdate): void => {
    // Preserve transcript update order even when counting messages requires an
    // async read from the session file.
    broadcastQueue = broadcastQueue
      .then(() => handleTranscriptUpdateBroadcast(params, update))
      .catch(() => undefined);
  };
}

async function handleTranscriptUpdateBroadcast(
  params: {
    broadcastToConnIds: GatewayBroadcastToConnIdsFn;
    sessionEventSubscribers: SessionEventSubscribers;
    sessionMessageSubscribers: SessionMessageSubscribers;
  },
  update: SessionTranscriptUpdate,
): Promise<void> {
  const sessionKey = update.sessionKey ?? resolveSessionKeyForTranscriptFile(update.sessionFile);
  if (!sessionKey || update.message === undefined) {
    return;
  }
  const effectiveAgentId = update.agentId;
  const defaultGlobalAgentId =
    sessionKey === "global"
      ? normalizeAgentId(resolveDefaultAgentId(getRuntimeConfig()))
      : undefined;
  const visibleAgentId =
    update.agentId ??
    (effectiveAgentId && effectiveAgentId !== defaultGlobalAgentId ? effectiveAgentId : undefined);
  const connIds = new Set<string>();
  for (const connId of params.sessionEventSubscribers.getAll()) {
    connIds.add(connId);
  }
  for (const broadcastKey of resolveSessionMessageBroadcastKeys(sessionKey, effectiveAgentId)) {
    for (const connId of params.sessionMessageSubscribers.get(broadcastKey)) {
      connIds.add(connId);
    }
  }
  if (connIds.size === 0) {
    return;
  }
  let messageSeq = asPositiveSafeInteger(update.messageSeq);
  if (messageSeq === undefined) {
    // Updates from raw transcript events may not carry seq; fall back to the
    // current transcript line count for cursor-compatible live history.
    const { entry, storePath } = loadSessionEntry(sessionKey, { agentId: visibleAgentId });
    messageSeq = entry?.sessionId
      ? asPositiveSafeInteger(
          await readSessionMessageCountAsync(entry.sessionId, storePath, entry.sessionFile),
        )
      : undefined;
  }
  const sessionSnapshot = buildGatewaySessionSnapshot({
    sessionRow: loadGatewaySessionRow(sessionKey, {
      agentId: visibleAgentId,
      transcriptUsageMaxBytes: 64 * 1024,
    }),
    agentId: visibleAgentId,
    includeSession: true,
  });
  const rawMessage = attachOpenClawTranscriptMeta(update.message, {
    ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
    ...(messageSeq !== undefined ? { seq: messageSeq } : {}),
  });
  const message = projectChatDisplayMessage(rawMessage);
  if (message) {
    params.broadcastToConnIds(
      "session.message",
      {
        sessionKey,
        ...(visibleAgentId ? { agentId: visibleAgentId } : {}),
        message,
        ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
        ...(messageSeq !== undefined ? { messageSeq } : {}),
        ...sessionSnapshot,
      },
      connIds,
      { dropIfSlow: true },
    );
    return;
  }

  // Messages suppressed from display can still change transcript state, so
  // notify broad session listeners even when no session.message is emitted.
  const sessionEventConnIds = params.sessionEventSubscribers.getAll();
  if (sessionEventConnIds.size === 0) {
    return;
  }
  params.broadcastToConnIds(
    "sessions.changed",
    {
      sessionKey,
      ...(visibleAgentId ? { agentId: visibleAgentId } : {}),
      phase: "message",
      ts: Date.now(),
      ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
      ...(messageSeq !== undefined ? { messageSeq } : {}),
      ...sessionSnapshot,
    },
    sessionEventConnIds,
    { dropIfSlow: true },
  );
}

/** Creates a lifecycle-event broadcaster for session list refreshes. */
export function createLifecycleEventBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
}) {
  return (event: SessionLifecycleEvent): void => {
    const connIds = params.sessionEventSubscribers.getAll();
    if (connIds.size === 0) {
      return;
    }
    params.broadcastToConnIds(
      "sessions.changed",
      {
        sessionKey: event.sessionKey,
        reason: event.reason,
        parentSessionKey: event.parentSessionKey,
        label: event.label,
        displayName: event.displayName,
        ts: Date.now(),
        ...buildGatewaySessionSnapshot({
          sessionRow: loadGatewaySessionRow(event.sessionKey),
          label: event.label,
          displayName: event.displayName,
          parentSessionKey: event.parentSessionKey,
        }),
      },
      connIds,
      { dropIfSlow: true },
    );
  };
}

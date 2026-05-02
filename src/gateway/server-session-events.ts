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

function buildGatewaySessionSnapshot(params: {
  sessionRow: GatewaySessionRow | null | undefined;
  includeSession?: boolean;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
}): Record<string, unknown> {
  const { sessionRow } = params;
  if (!sessionRow) {
    return {};
  }
  return {
    ...(params.includeSession ? { session: sessionRow } : {}),
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

export function createTranscriptUpdateBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  sessionMessageSubscribers: SessionMessageSubscribers;
}) {
  let broadcastQueue = Promise.resolve();
  return (update: SessionTranscriptUpdate): void => {
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
  const connIds = new Set<string>();
  for (const connId of params.sessionEventSubscribers.getAll()) {
    connIds.add(connId);
  }
  for (const connId of params.sessionMessageSubscribers.get(sessionKey)) {
    connIds.add(connId);
  }
  if (connIds.size === 0) {
    return;
  }
  const { entry, storePath } = loadSessionEntry(sessionKey);
  const messageSeq = entry?.sessionId
    ? await readSessionMessageCountAsync(entry.sessionId, storePath, entry.sessionFile)
    : undefined;
  const sessionSnapshot = buildGatewaySessionSnapshot({
    sessionRow: loadGatewaySessionRow(sessionKey, { transcriptUsageMaxBytes: 64 * 1024 }),
    includeSession: true,
  });
  const rawMessage = attachOpenClawTranscriptMeta(update.message, {
    ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
    ...(typeof messageSeq === "number" ? { seq: messageSeq } : {}),
  });
  const message = projectChatDisplayMessage(rawMessage);
  if (message) {
    params.broadcastToConnIds(
      "session.message",
      {
        sessionKey,
        message,
        ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
        ...(typeof messageSeq === "number" ? { messageSeq } : {}),
        ...sessionSnapshot,
      },
      connIds,
      { dropIfSlow: true },
    );
  }

  const sessionEventConnIds = params.sessionEventSubscribers.getAll();
  if (sessionEventConnIds.size === 0) {
    return;
  }
  params.broadcastToConnIds(
    "sessions.changed",
    {
      sessionKey,
      phase: "message",
      ts: Date.now(),
      ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
      ...(typeof messageSeq === "number" ? { messageSeq } : {}),
      ...sessionSnapshot,
    },
    sessionEventConnIds,
    { dropIfSlow: true },
  );
}

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

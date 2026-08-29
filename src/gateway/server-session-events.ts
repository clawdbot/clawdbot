// Gateway session event broadcaster.
// Projects transcript and lifecycle updates to websocket subscribers.
import path from "node:path";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  readTranscriptDisplayPosition,
  type TranscriptDisplayPosition,
} from "../chat/transcript-display-position.js";
import { getRuntimeConfig } from "../config/io.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadSessionEntryReadOnly as loadAccessorSessionEntryReadOnly,
  resolveTranscriptSessionKeyBySessionId,
} from "../config/sessions/session-accessor.js";
import { isSessionTranscriptProjectionUnavailableError } from "../config/sessions/session-transcript-projection-error.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import type { SessionLifecycleEvent } from "../sessions/session-lifecycle-events.js";
import type { InternalSessionTranscriptUpdate } from "../sessions/transcript-events.js";
import type { ChatAbortControllerEntry } from "./chat-abort.js";
import { projectChatDisplayMessage } from "./chat-display-projection.js";
import type { GatewayBroadcastToConnIdsFn } from "./server-broadcast-types.js";
import type {
  SessionEventSubscriberRegistry,
  SessionMessageSubscriberRegistry,
} from "./server-chat.js";
import { resolveVisibleActiveSessionRunState } from "./server-methods/session-active-runs.js";
import { hasSessionChangeReceivers } from "./session-change-receivers.js";
import { buildGatewaySessionSnapshot } from "./session-event-payload.js";
import {
  resolvePrivateSessionEventBroadcastScope,
  resolveSessionEventAgentScope,
  type SessionEventAgentScope,
} from "./session-request-agent.js";
import {
  resolveSessionSubscriptionKey,
  resolveSessionSubscriptionKeys,
} from "./session-subscription-keys.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";
import {
  readSessionMessageByIdAsync,
  readSessionMessageCountAsync,
} from "./session-transcript-readers.js";
import { loadGatewaySessionRow, loadGatewaySessionEntryReadOnly } from "./session-utils.js";

type SessionEventSubscribers = Pick<SessionEventSubscriberRegistry, "getAll">;
type SessionMessageSubscribers = Pick<SessionMessageSubscriberRegistry, "get">;

function readTranscriptUpdateLifecycleOwner(
  update: InternalSessionTranscriptUpdate,
): { lifecycleRevision?: string } | undefined {
  const marker = parseSqliteSessionFileMarker(update.sessionFile);
  const sessionKey =
    normalizeOptionalString(update.target?.sessionKey) ??
    normalizeOptionalString(update.sessionKey) ??
    (marker ? resolveTranscriptSessionKeyBySessionId(marker) : undefined);
  if (!sessionKey) {
    return undefined;
  }
  const agentId =
    normalizeOptionalString(update.target?.agentId) ??
    normalizeOptionalString(update.agentId) ??
    marker?.agentId;
  const sessionId =
    normalizeOptionalString(update.target?.sessionId) ??
    normalizeOptionalString(update.sessionId) ??
    marker?.sessionId;
  const storePath = normalizeOptionalString(update.target?.storePath) ?? marker?.storePath;
  const entry = storePath
    ? loadAccessorSessionEntryReadOnly({ agentId, sessionKey, storePath })
    : loadGatewaySessionEntryReadOnly(sessionKey, agentId ? { agentId } : undefined)?.entry;
  if (!entry || (sessionId && entry.sessionId !== sessionId)) {
    return undefined;
  }
  const lifecycleRevision = normalizeOptionalString(entry.lifecycleRevision);
  return lifecycleRevision ? { lifecycleRevision } : {};
}

/** Creates a serialized transcript-update broadcaster for session websocket clients. */
export function createTranscriptUpdateBroadcastHandler(params: {
  broadcastToConnIds: GatewayBroadcastToConnIdsFn;
  sessionEventSubscribers: SessionEventSubscribers;
  sessionMessageSubscribers: SessionMessageSubscribers;
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
}) {
  // Ordering is a per-transcript contract: subscribers merge each session's
  // updates independently, so lanes keyed by transcript identity keep message
  // order without one session's async seq reads stalling every other session.
  const broadcastQueues = new Map<string, Promise<void>>();
  return (update: InternalSessionTranscriptUpdate): Promise<void> => {
    // Capture legacy ownership before the async queue can cross a same-id reset;
    // committed producer ownership always wins over a later session-store read.
    const lifecycleRevision =
      normalizeOptionalString(update.lifecycleRevision) ??
      (update.message !== undefined
        ? readTranscriptUpdateLifecycleOwner(update)?.lifecycleRevision
        : undefined);
    const queuedUpdate = lifecycleRevision ? { ...update, lifecycleRevision } : update;
    const legacyMarker = parseSqliteSessionFileMarker(update.sessionFile);
    const sessionKey =
      normalizeOptionalString(update.target?.sessionKey) ??
      normalizeOptionalString(update.sessionKey) ??
      (legacyMarker ? resolveTranscriptSessionKeyBySessionId(legacyMarker) : undefined);
    const agentId =
      normalizeOptionalString(update.target?.agentId) ??
      normalizeOptionalString(update.agentId) ??
      legacyMarker?.agentId;
    const agentScope = sessionKey
      ? resolveSessionEventAgentScope(getRuntimeConfig(), sessionKey, agentId)
      : undefined;
    if (agentScope === null) {
      return Promise.resolve();
    }
    // Raw global is per-agent storage identity; its qualified aliases must share a lane.
    const laneKey =
      sessionKey && agentScope?.[1]
        ? resolveSessionSubscriptionKey(sessionKey, agentScope[1])
        : (sessionKey ?? normalizeOptionalString(update.sessionFile) ?? "");
    // Preserve transcript update order within the lane even when counting
    // messages requires an async read from the session file.
    const tail = broadcastQueues.get(laneKey) ?? Promise.resolve();
    const task = tail.then(() => handleTranscriptUpdateBroadcast(params, queuedUpdate, agentScope));
    const settled = task.then(
      () => undefined,
      () => undefined,
    );
    broadcastQueues.set(laneKey, settled);
    void settled.then(() => {
      // Drop drained lanes so idle sessions do not accumulate map entries.
      if (broadcastQueues.get(laneKey) === settled) {
        broadcastQueues.delete(laneKey);
      }
    });
    return task;
  };
}

async function handleTranscriptUpdateBroadcast(
  params: {
    broadcastToConnIds: GatewayBroadcastToConnIdsFn;
    sessionEventSubscribers: SessionEventSubscribers;
    sessionMessageSubscribers: SessionMessageSubscribers;
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  },
  update: InternalSessionTranscriptUpdate,
  capturedAgentScope: SessionEventAgentScope | undefined,
): Promise<void> {
  const legacyMarker = parseSqliteSessionFileMarker(update.sessionFile);
  const targetAgentId = normalizeOptionalString(update.target?.agentId);
  const targetSessionId = normalizeOptionalString(update.target?.sessionId);
  const targetSessionKey = normalizeOptionalString(update.target?.sessionKey);
  const suppliedSessionKey = normalizeOptionalString(update.sessionKey);
  const candidateSessionKey = targetSessionKey ?? suppliedSessionKey;
  const targetKeyAgentId = parseAgentSessionKey(candidateSessionKey)?.agentId;
  const targetStorePath = normalizeOptionalString(update.target?.storePath);
  const completeTarget = Boolean(
    targetAgentId && targetSessionId && targetSessionKey && targetStorePath,
  );
  const markerSessionKey =
    legacyMarker && !completeTarget
      ? resolveTranscriptSessionKeyBySessionId(legacyMarker)
      : undefined;
  const markerMatches =
    legacyMarker && !completeTarget
      ? listAccessorSessionEntriesReadOnly({
          agentId: legacyMarker.agentId,
          storePath: legacyMarker.storePath,
        }).filter(({ entry }) => entry.sessionId === legacyMarker.sessionId)
      : [];
  const candidateKeyEntry =
    candidateSessionKey && legacyMarker && !completeTarget
      ? loadAccessorSessionEntryReadOnly({
          agentId: legacyMarker.agentId,
          sessionKey: candidateSessionKey,
          storePath: legacyMarker.storePath,
        })
      : undefined;
  if (targetKeyAgentId && targetAgentId && targetKeyAgentId !== targetAgentId) {
    return;
  }
  if (
    legacyMarker &&
    !completeTarget &&
    ((targetAgentId && targetAgentId !== legacyMarker.agentId) ||
      (targetSessionId &&
        targetSessionId !== legacyMarker.sessionId &&
        candidateKeyEntry?.sessionId !== legacyMarker.sessionId) ||
      (targetKeyAgentId && targetKeyAgentId !== legacyMarker.agentId) ||
      (candidateSessionKey &&
        ((candidateKeyEntry && candidateKeyEntry.sessionId !== legacyMarker.sessionId) ||
          (!candidateKeyEntry && markerMatches.length > 0))) ||
      (targetStorePath && path.resolve(targetStorePath) !== path.resolve(legacyMarker.storePath)))
  ) {
    return;
  }
  const compatibleLegacyMarker = completeTarget ? undefined : legacyMarker;
  const sessionKey = compatibleLegacyMarker
    ? candidateKeyEntry?.sessionId === compatibleLegacyMarker.sessionId ||
      (!candidateKeyEntry && markerMatches.length === 0)
      ? candidateSessionKey
      : markerSessionKey
    : candidateSessionKey;
  if (!sessionKey) {
    return;
  }
  const agentScope =
    capturedAgentScope ??
    resolveSessionEventAgentScope(
      getRuntimeConfig(),
      sessionKey,
      compatibleLegacyMarker?.agentId ?? targetAgentId ?? update.agentId,
    );
  if (!agentScope) {
    return;
  }
  const [eventAgentId, routingAgentId, compatibilityOwnerAgentId] = agentScope;
  const privateBroadcastScope = resolvePrivateSessionEventBroadcastScope(sessionKey, agentScope);
  const connIds = new Set<string>();
  for (const connId of params.sessionEventSubscribers.getAll()) {
    connIds.add(connId);
  }
  const broadcastKeys = routingAgentId
    ? resolveSessionSubscriptionKeys(sessionKey, routingAgentId, compatibilityOwnerAgentId)
    : [sessionKey];
  for (const broadcastKey of broadcastKeys) {
    for (const connId of params.sessionMessageSubscribers.get(broadcastKey)) {
      connIds.add(connId);
    }
  }
  if (connIds.size === 0) {
    if (
      !hasSessionChangeReceivers(connIds) ||
      (update.message !== undefined && projectChatDisplayMessage(update.message))
    ) {
      return;
    }
  }
  const lifecycleRevision = normalizeOptionalString(update.lifecycleRevision);
  if (!eventAgentId && !compatibilityOwnerAgentId && !parseAgentSessionKey(sessionKey)) {
    if (lifecycleRevision) {
      const currentLifecycleOwner = readTranscriptUpdateLifecycleOwner(update);
      if (
        !currentLifecycleOwner ||
        (currentLifecycleOwner.lifecycleRevision &&
          currentLifecycleOwner.lifecycleRevision !== lifecycleRevision)
      ) {
        return;
      }
    }
    params.broadcastToConnIds(
      "sessions.changed",
      { sessionKey, phase: "message", ts: Date.now() },
      connIds,
      {
        ...privateBroadcastScope,
        dropIfSlow: true,
      },
    );
    return;
  }
  let message = update.message;
  let messageSeq = asPositiveSafeInteger(update.messageSeq);
  let transcriptPosition: TranscriptDisplayPosition | undefined;
  if (message !== undefined && update.messageId && completeTarget && targetSessionId) {
    // A queued append can cross a rewrite. Read content and placement together;
    // never attach a new generation to the producer's stale queued payload.
    try {
      const stored = await readSessionMessageByIdAsync(
        {
          agentId: targetAgentId,
          sessionId: targetSessionId,
          sessionKey,
          storePath: targetStorePath,
        },
        update.messageId,
      );
      message = stored.message;
      messageSeq = stored.seq;
      transcriptPosition = readTranscriptDisplayPosition(
        asOptionalRecord(asOptionalRecord(message)?.["__openclaw"])?.transcriptPosition,
      );
    } catch (error) {
      if (!isSessionTranscriptProjectionUnavailableError(error)) {
        throw error;
      }
      message = undefined;
    }
  } else if (message !== undefined && messageSeq === undefined) {
    // Updates from raw transcript events may not carry seq; fall back to the
    // current transcript line count for cursor-compatible live history.
    const updateStorePath = targetStorePath ?? compatibleLegacyMarker?.storePath;
    const fallbackTarget = updateStorePath
      ? {
          entry: loadAccessorSessionEntryReadOnly({
            agentId: routingAgentId,
            sessionKey,
            storePath: updateStorePath,
          }),
          storePath: updateStorePath,
        }
      : loadGatewaySessionEntryReadOnly(sessionKey, { agentId: routingAgentId });
    const entry = fallbackTarget?.entry;
    const messageSessionId =
      compatibleLegacyMarker?.sessionId ??
      normalizeOptionalString(update.target?.sessionId) ??
      entry?.sessionId;
    const storePath = updateStorePath ?? fallbackTarget?.storePath;
    messageSeq = messageSessionId
      ? asPositiveSafeInteger(
          await readSessionMessageCountAsync({
            agentId: update.target?.agentId ?? routingAgentId,
            sessionEntry: entry,
            sessionId: messageSessionId,
            sessionKey,
            storePath,
          }),
        )
      : undefined;
  }
  if (lifecycleRevision) {
    // A reset can retain sessionId, so validate the captured owner after every
    // awaited transcript read before projecting the current session snapshot.
    const currentLifecycleOwner = readTranscriptUpdateLifecycleOwner(update);
    if (
      !currentLifecycleOwner ||
      (currentLifecycleOwner.lifecycleRevision &&
        currentLifecycleOwner.lifecycleRevision !== lifecycleRevision)
    ) {
      return;
    }
  }
  // Message frames must keep transcript-derived live usage (dashboard API
  // contract from #50101); the 64KB cap bounds the per-message tail read.
  const sessionRow = loadGatewaySessionRow(sessionKey, {
    agentId: routingAgentId,
    transcriptUsageMaxBytes: 64 * 1024,
  });
  const activeRunState =
    sessionRow &&
    (sessionRow.key !== "global" || routingAgentId !== undefined || compatibilityOwnerAgentId)
      ? resolveVisibleActiveSessionRunState({
          context: params,
          requestedKey: sessionKey,
          canonicalKey: sessionRow.key,
          sessionId: sessionRow.sessionId,
          ...(routingAgentId ? { agentId: routingAgentId } : {}),
          defaultAgentId: compatibilityOwnerAgentId,
        })
      : null;
  const sessionSnapshot = buildGatewaySessionSnapshot({
    sessionRow,
    agentId: eventAgentId,
    includeSession: true,
    activeRunState,
    status: activeRunState?.active ? (activeRunState.status ?? "running") : undefined,
  });
  if (message === undefined) {
    // A committed batch or unavailable selected row must invalidate
    // both session-list and targeted transcript subscribers exactly once.
    params.broadcastToConnIds(
      "sessions.changed",
      {
        sessionKey,
        ...(eventAgentId ? { agentId: eventAgentId } : {}),
        phase: "message",
        ts: Date.now(),
        ...sessionSnapshot,
      },
      connIds,
    );
    return;
  }
  const projected = projectSessionMessagePayload({
    sessionKey,
    ...(eventAgentId ? { agentId: eventAgentId } : {}),
    message,
    transcriptPosition,
    ...(typeof update.messageId === "string" ? { messageId: update.messageId } : {}),
    ...(messageSeq !== undefined ? { messageSeq } : {}),
    ...(update.runId ? { runId: update.runId } : {}),
    sessionSnapshot,
  });
  if (projected.payload) {
    params.broadcastToConnIds("session.message", projected.payload, connIds);
    return;
  }

  // Messages suppressed from display can still change transcript state, so
  // notify broad session listeners even when no session.message is emitted.
  const sessionEventConnIds = params.sessionEventSubscribers.getAll();
  if (!hasSessionChangeReceivers(sessionEventConnIds)) {
    return;
  }
  params.broadcastToConnIds(
    "sessions.changed",
    {
      sessionKey,
      ...(eventAgentId ? { agentId: eventAgentId } : {}),
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
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
}) {
  return (event: SessionLifecycleEvent): void => {
    const swarmEvent = event as SessionLifecycleEvent & {
      swarmGroupId?: string;
      kind?: "phase" | "log";
      text?: string;
    };
    const connIds = params.sessionEventSubscribers.getAll();
    if (!hasSessionChangeReceivers(connIds)) {
      return;
    }
    const agentScope = resolveSessionEventAgentScope(
      getRuntimeConfig(),
      event.sessionKey,
      normalizeOptionalString(event.agentId),
      true,
    );
    if (!agentScope) {
      return;
    }
    const [eventAgentId, routingAgentId, compatibilityOwnerAgentId] = agentScope;
    const privateBroadcastScope = resolvePrivateSessionEventBroadcastScope(
      event.sessionKey,
      agentScope,
    );
    const broadcastOptions = { ...privateBroadcastScope, dropIfSlow: true };
    // Key-only lifecycle deletes invalidate membership; a later row is not deletion evidence.
    if (
      event.reason === "delete" ||
      !routingAgentId ||
      (!eventAgentId && !compatibilityOwnerAgentId)
    ) {
      params.broadcastToConnIds(
        "sessions.changed",
        {
          sessionKey: event.sessionKey,
          ...(eventAgentId ? { agentId: eventAgentId } : {}),
          reason: event.reason,
          ts: Date.now(),
        },
        connIds,
        broadcastOptions,
      );
      return;
    }
    const sessionRow = loadGatewaySessionRow(event.sessionKey, { agentId: routingAgentId });
    const activeRunState =
      sessionRow && (sessionRow.key !== "global" || routingAgentId)
        ? resolveVisibleActiveSessionRunState({
            context: params,
            requestedKey: event.sessionKey,
            canonicalKey: sessionRow.key,
            sessionId: sessionRow.sessionId,
            ...(routingAgentId ? { agentId: routingAgentId } : {}),
            defaultAgentId: compatibilityOwnerAgentId,
          })
        : null;
    params.broadcastToConnIds(
      "sessions.changed",
      {
        sessionKey: event.sessionKey,
        ...(eventAgentId ? { agentId: eventAgentId } : {}),
        reason: event.reason,
        parentSessionKey: event.parentSessionKey,
        label: event.label,
        displayName: event.displayName,
        ts: Date.now(),
        ...buildGatewaySessionSnapshot({
          sessionRow,
          agentId: eventAgentId,
          label: event.label,
          displayName: event.displayName,
          parentSessionKey: event.parentSessionKey,
          activeRunState,
        }),
        ...(swarmEvent.swarmGroupId
          ? {
              swarmGroupId: swarmEvent.swarmGroupId,
              kind: swarmEvent.kind,
              text: swarmEvent.text,
            }
          : {}),
      },
      connIds,
      { dropIfSlow: true },
    );
  };
}

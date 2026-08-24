// Gateway session event broadcaster.
// Projects transcript and lifecycle updates to websocket subscribers.
import path from "node:path";
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getRuntimeConfig } from "../config/io.js";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { parseSqliteSessionFileMarker } from "../config/sessions/legacy-sqlite-marker.js";
import {
  listSessionEntriesReadOnly as listAccessorSessionEntriesReadOnly,
  loadSessionEntryReadOnly as loadAccessorSessionEntryReadOnly,
  resolveTranscriptSessionKeyBySessionId,
} from "../config/sessions/session-accessor.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
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
import {
  buildGatewaySessionEventFields,
  buildGatewaySessionEventRow,
  projectSessionEventActiveRunIds,
} from "./session-event-payload.js";
import {
  resolveSessionSubscriptionKey,
  resolveSessionSubscriptionKeys,
} from "./session-subscription-keys.js";
import { projectSessionMessagePayload } from "./session-transcript-message.js";
import { readSessionMessageCountAsync } from "./session-transcript-readers.js";
import {
  loadGatewaySessionRow,
  loadGatewaySessionEntryReadOnly,
  type GatewaySessionRow,
} from "./session-utils.js";

type SessionEventSubscribers = Pick<SessionEventSubscriberRegistry, "getAll">;
type SessionMessageSubscribers = Pick<SessionMessageSubscriberRegistry, "get">;

function tryResolveCompatibilityDefaultAgentId(): string | undefined {
  return tryResolveLegacyCompatibilityAgentId(getRuntimeConfig());
}

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

export function buildGatewaySessionSnapshot(params: {
  sessionRow: GatewaySessionRow | null | undefined;
  agentId?: string;
  includeSession?: boolean;
  label?: string;
  displayName?: string;
  parentSessionKey?: string;
  status?: GatewaySessionRow["status"];
  hasActiveRun?: boolean;
  activeRunIds?: string[] | null;
}): Record<string, unknown> {
  const { sessionRow } = params;
  if (!sessionRow) {
    return {};
  }
  // Nested snapshots are the UI merge source, so preserve explicit clear semantics there too.
  const session: Record<string, unknown> | undefined = params.includeSession
    ? {
        ...buildGatewaySessionEventRow(sessionRow),
        createdActor: sessionRow.createdActor ?? null,
        thinkingLevel: sessionRow.thinkingLevel ?? null,
      }
    : undefined;
  if (session && sessionRow.key === "global" && !params.agentId) {
    // The unscoped global row hides goal state to avoid presenting one agent's
    // scoped goal as the global/default session goal.
    delete session.goal;
  }
  if (session && params.status !== undefined) {
    session.status = params.status;
  }
  if (session && params.hasActiveRun !== undefined) {
    session.hasActiveRun = params.hasActiveRun;
  }
  if (session && params.activeRunIds !== undefined) {
    session.activeRunIds = params.activeRunIds;
  }
  return {
    ...(session ? { session } : {}),
    ...buildGatewaySessionEventFields({
      sessionRow,
      agentId: params.agentId,
      label: params.label,
      displayName: params.displayName,
      parentSessionKey: params.parentSessionKey,
      status: params.status,
      hasActiveRun: params.hasActiveRun,
      activeRunIds: params.activeRunIds,
    }),
    subagentRunState: sessionRow.subagentRunState,
    hasActiveSubagentRun: sessionRow.hasActiveSubagentRun,
  };
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
    let agentId =
      normalizeOptionalString(update.target?.agentId) ??
      normalizeOptionalString(update.agentId) ??
      legacyMarker?.agentId;
    if (!agentId && sessionKey?.toLowerCase() === "global") {
      const config = getRuntimeConfig();
      const persistedOwner = resolvePersistedSessionStoreOwnerForKey(config, sessionKey);
      agentId =
        persistedOwner.kind === "configured"
          ? persistedOwner.agentId
          : tryResolveLegacyCompatibilityAgentId(config);
    }
    // Raw global is per-agent storage identity; its qualified aliases must share a lane.
    const laneKey =
      sessionKey && agentId
        ? resolveSessionSubscriptionKey(sessionKey, agentId)
        : (sessionKey ?? normalizeOptionalString(update.sessionFile) ?? "");
    // Preserve transcript update order within the lane even when counting
    // messages requires an async read from the session file.
    const tail = broadcastQueues.get(laneKey) ?? Promise.resolve();
    const task = tail.then(() => handleTranscriptUpdateBroadcast(params, queuedUpdate));
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
  const effectiveAgentId = compatibleLegacyMarker?.agentId ?? targetAgentId ?? update.agentId;
  const compatibilityDefaultAgentId = tryResolveCompatibilityDefaultAgentId();
  const persistedOwner = resolvePersistedSessionStoreOwnerForKey(getRuntimeConfig(), sessionKey);
  const stableCompatibilityAgentId =
    persistedOwner.kind === "configured" ? persistedOwner.agentId : compatibilityDefaultAgentId;
  const stableUnscopedOwner =
    !parseAgentSessionKey(sessionKey) && !effectiveAgentId ? stableCompatibilityAgentId : undefined;
  const storageAgentId = effectiveAgentId ?? stableUnscopedOwner;
  const visibleAgentId = effectiveAgentId;
  const routingAgentId = effectiveAgentId ?? stableUnscopedOwner;
  const connIds = new Set<string>();
  for (const connId of params.sessionEventSubscribers.getAll()) {
    connIds.add(connId);
  }
  let broadcastKeys = [sessionKey];
  if (sessionKey === "global" && routingAgentId) {
    broadcastKeys = resolveSessionSubscriptionKeys(
      sessionKey,
      routingAgentId,
      stableCompatibilityAgentId,
    );
  }
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
  let messageSeq = asPositiveSafeInteger(update.messageSeq);
  if (update.message !== undefined && messageSeq === undefined) {
    // Updates from raw transcript events may not carry seq; fall back to the
    // current transcript line count for cursor-compatible live history.
    const updateStorePath = targetStorePath ?? compatibleLegacyMarker?.storePath;
    const fallbackTarget = updateStorePath
      ? {
          entry: loadAccessorSessionEntryReadOnly({
            agentId: storageAgentId ?? routingAgentId,
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
            agentId: update.target?.agentId ?? storageAgentId ?? routingAgentId,
            sessionEntry: entry,
            sessionId: messageSessionId,
            sessionKey,
            storePath,
          }),
        )
      : undefined;
  }
  const lifecycleRevision = normalizeOptionalString(update.lifecycleRevision);
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
    (sessionRow.key !== "global" || routingAgentId !== undefined || compatibilityDefaultAgentId)
      ? resolveVisibleActiveSessionRunState({
          context: params,
          requestedKey: sessionKey,
          canonicalKey: sessionRow.key,
          sessionId: sessionRow.sessionId,
          ...(routingAgentId ? { agentId: routingAgentId } : {}),
          defaultAgentId: stableUnscopedOwner,
        })
      : null;
  const sessionSnapshot = buildGatewaySessionSnapshot({
    sessionRow,
    agentId: routingAgentId,
    includeSession: true,
    status: activeRunState?.active ? (activeRunState.status ?? "running") : undefined,
    hasActiveRun: activeRunState?.active,
    activeRunIds: projectSessionEventActiveRunIds(activeRunState),
  });
  if (update.message === undefined) {
    // A committed batch without individually proven cursors must invalidate
    // both session-list and targeted transcript subscribers exactly once.
    params.broadcastToConnIds(
      "sessions.changed",
      {
        sessionKey,
        ...(visibleAgentId ? { agentId: visibleAgentId } : {}),
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
    ...(visibleAgentId ? { agentId: visibleAgentId } : {}),
    message: update.message,
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
    const compatibilityDefaultAgentId = tryResolveCompatibilityDefaultAgentId();
    const eventAgentId =
      normalizeOptionalString(event.agentId) ?? parseAgentSessionKey(event.sessionKey)?.agentId;
    const persistedOwner = resolvePersistedSessionStoreOwnerForKey(
      getRuntimeConfig(),
      event.sessionKey,
    );
    const stableOwnerAgentId =
      (persistedOwner.kind === "configured" ? persistedOwner.agentId : undefined) ??
      compatibilityDefaultAgentId;
    const rowAgentId = eventAgentId ?? stableOwnerAgentId;
    const sessionRow = rowAgentId
      ? loadGatewaySessionRow(event.sessionKey, { agentId: rowAgentId })
      : undefined;
    const activeRunState =
      sessionRow && (sessionRow.key !== "global" || rowAgentId)
        ? resolveVisibleActiveSessionRunState({
            context: params,
            requestedKey: event.sessionKey,
            canonicalKey: sessionRow.key,
            sessionId: sessionRow.sessionId,
            ...(rowAgentId ? { agentId: rowAgentId } : {}),
            defaultAgentId: stableOwnerAgentId,
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
          label: event.label,
          displayName: event.displayName,
          parentSessionKey: event.parentSessionKey,
          hasActiveRun: activeRunState?.active,
          activeRunIds: projectSessionEventActiveRunIds(activeRunState),
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

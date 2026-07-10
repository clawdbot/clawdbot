// Gateway session event broadcaster.
// Projects transcript and lifecycle updates to websocket subscribers.
import { asPositiveSafeInteger } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import { normalizeAgentId } from "../routing/session-key.js";
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
import {
  buildGatewaySessionEventFields,
  buildGatewaySessionEventRow,
} from "./session-event-payload.js";
import { resolveSessionKeyForTranscriptFile } from "./session-transcript-key.js";
import {
  attachOpenClawTranscriptMeta,
  readSessionMessageCountAsync,
} from "./session-transcript-readers.js";
import {
  loadGatewaySessionRow,
  loadSessionEntry,
  type GatewaySessionRow,
} from "./session-utils.js";

type SessionEventSubscribers = Pick<SessionEventSubscriberRegistry, "getAll">;
type SessionMessageSubscribers = Pick<SessionMessageSubscriberRegistry, "get">;

function readMessageIdempotencyKey(message: unknown): string | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const value = (message as Record<string, unknown>).idempotencyKey;
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readMessageSenderIsOwner(message: unknown): boolean | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const openclaw = (message as Record<string, unknown>)["__openclaw"];
  if (!openclaw || typeof openclaw !== "object" || Array.isArray(openclaw)) {
    return undefined;
  }
  const value = (openclaw as Record<string, unknown>).senderIsOwner;
  return typeof value === "boolean" ? value : undefined;
}

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
  hasActiveRun?: boolean;
  activeRunIds?: string[];
}): Record<string, unknown> {
  const { sessionRow } = params;
  if (!sessionRow) {
    return {};
  }
  // Nested snapshots are the UI merge source, so preserve explicit clear semantics there too.
  const session = params.includeSession
    ? {
        ...buildGatewaySessionEventRow(sessionRow),
        thinkingLevel: sessionRow.thinkingLevel ?? null,
      }
    : undefined;
  if (session && sessionRow.key === "global" && !params.agentId) {
    // The unscoped global row hides goal state to avoid presenting one agent's
    // scoped goal as the global/default session goal.
    delete session.goal;
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
  let broadcastQueue = Promise.resolve();
  return (update: InternalSessionTranscriptUpdate): void => {
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
    chatAbortControllers: Map<string, ChatAbortControllerEntry>;
  },
  update: InternalSessionTranscriptUpdate,
): Promise<void> {
  const sessionKey =
    update.target?.sessionKey ??
    update.sessionKey ??
    (update.sessionFile ? resolveSessionKeyForTranscriptFile(update.sessionFile) : undefined);
  if (!sessionKey || update.message === undefined) {
    return;
  }
  const effectiveAgentId = update.target?.agentId ?? update.agentId;
  const defaultGlobalAgentId =
    sessionKey === "global"
      ? normalizeAgentId(resolveDefaultAgentId(getRuntimeConfig()))
      : undefined;
  const visibleAgentId =
    effectiveAgentId ??
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
          await readSessionMessageCountAsync({
            agentId: visibleAgentId,
            sessionEntry: entry,
            sessionId: entry.sessionId,
            sessionKey,
            storePath,
          }),
        )
      : undefined;
  }
  const sessionRow = loadGatewaySessionRow(sessionKey, {
    agentId: visibleAgentId,
    transcriptUsageMaxBytes: 64 * 1024,
  });
  const activeRunState = sessionRow
    ? resolveVisibleActiveSessionRunState({
        context: params,
        requestedKey: sessionKey,
        canonicalKey: sessionRow.key,
        sessionId: sessionRow.sessionId,
        ...(sessionRow.key === "global" && visibleAgentId ? { agentId: visibleAgentId } : {}),
        defaultAgentId: normalizeAgentId(resolveDefaultAgentId(getRuntimeConfig())),
      })
    : null;
  const sessionSnapshot = buildGatewaySessionSnapshot({
    sessionRow,
    agentId: visibleAgentId,
    includeSession: true,
    hasActiveRun: activeRunState?.active,
    activeRunIds: activeRunState?.runIds,
  });
  const idempotencyKey = readMessageIdempotencyKey(update.message);
  const senderIsOwner = readMessageSenderIsOwner(update.message);
  const rawMessage = attachOpenClawTranscriptMeta(update.message, {
    ...(typeof update.messageId === "string" ? { id: update.messageId } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(messageSeq !== undefined ? { seq: messageSeq } : {}),
  });
  const message = projectChatDisplayMessage(rawMessage);
  if (message) {
    params.broadcastToConnIds(
      "session.message",
      {
        sessionKey,
        ...(senderIsOwner === undefined ? {} : { senderIsOwner }),
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
  chatAbortControllers: Map<string, ChatAbortControllerEntry>;
}) {
  return (event: SessionLifecycleEvent): void => {
    const connIds = params.sessionEventSubscribers.getAll();
    if (connIds.size === 0) {
      return;
    }
    const sessionRow = loadGatewaySessionRow(event.sessionKey);
    const activeRunState = sessionRow
      ? resolveVisibleActiveSessionRunState({
          context: params,
          requestedKey: event.sessionKey,
          canonicalKey: sessionRow.key,
          sessionId: sessionRow.sessionId,
          defaultAgentId: normalizeAgentId(resolveDefaultAgentId(getRuntimeConfig())),
        })
      : null;
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
          sessionRow,
          label: event.label,
          displayName: event.displayName,
          parentSessionKey: event.parentSessionKey,
          hasActiveRun: activeRunState?.active,
          activeRunIds: activeRunState?.runIds,
        }),
      },
      connIds,
      { dropIfSlow: true },
    );
  };
}

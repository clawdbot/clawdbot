import {
  createSessionProjection,
  readSessionMessageIdentity,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  type SessionProjectionEvent,
  type SessionMessageEnvelope,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import type { ApplicationInitialUserMessageHandoff } from "../../app/initial-user-message-handoff.ts";

const chatSessionProjections = new WeakMap<object, SessionProjectionState>();
// Display ownership outlives active-state cleanup. It is not the foreground
// terminal fence: an unowned final cannot suppress authoritative active rows.
const chatRunOwners = new WeakMap<object, string>();
const CHAT_PROJECTION_SCOPE_KEYS = [
  "sessionKey",
  "sessionId",
  "agentId",
  "lifecycleRevision",
  "activeLeafEntryId",
] as const;

type ChatSessionProjectionOwner = {
  sessionKey: string;
  chatMessages: unknown[];
  client?: object | null;
  initialUserMessage?: ApplicationInitialUserMessageHandoff;
  currentSessionId?: string | null;
  chatDisplayedLeafEntryId?: string | null;
};

type ChatSessionProjectionScopeOptions = Omit<SessionProjectionScope, "sessionId"> & {
  sessionId?: string | null;
};
type InitialUserMessageHandoffEntry = NonNullable<
  ReturnType<ApplicationInitialUserMessageHandoff["read"]>
>;

/** Every live, pending, terminal, and history path must identify the same pane and branch. */
export function readChatSessionProjectionScope(
  owner: ChatSessionProjectionOwner,
  options: ChatSessionProjectionScopeOptions = {},
): SessionProjectionScope {
  const sessionId = Object.hasOwn(options, "sessionId")
    ? options.sessionId
    : owner.currentSessionId;
  return {
    sessionKey: options.sessionKey ?? owner.sessionKey,
    ...(options.agentId ? { agentId: options.agentId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(options.lifecycleRevision !== undefined
      ? { lifecycleRevision: options.lifecycleRevision }
      : {}),
    ...(Object.hasOwn(options, "activeLeafEntryId") ||
    Object.hasOwn(owner, "chatDisplayedLeafEntryId")
      ? {
          activeLeafEntryId: Object.hasOwn(options, "activeLeafEntryId")
            ? (options.activeLeafEntryId ?? null)
            : (owner.chatDisplayedLeafEntryId ?? null),
        }
      : {}),
  };
}

function chatProjectionScopeChanged(
  previous: SessionProjectionScope,
  scope: SessionProjectionScope,
) {
  return CHAT_PROJECTION_SCOPE_KEYS.some(
    (key) =>
      Object.hasOwn(scope, key) && previous[key] !== undefined && previous[key] !== scope[key],
  );
}

/** One pane owns its shared-reducer projection; split panes never share live state. */
export function getChatSessionProjection(
  owner: object,
  messages: readonly unknown[] = [],
  scope: SessionProjectionScope = {},
): SessionProjectionState {
  const current = chatSessionProjections.get(owner);
  const scopeChanged = current !== undefined && chatProjectionScopeChanged(current.scope, scope);
  if (!current || scopeChanged) {
    const projection = createSessionProjection(scope, messages);
    setChatSessionProjection(owner, projection);
    return projection;
  }

  const bindsScope = CHAT_PROJECTION_SCOPE_KEYS.some(
    (key) =>
      Object.hasOwn(scope, key) && current.scope[key] === undefined && scope[key] !== undefined,
  );
  // Learning a durable session or leaf binds this pane without reclassifying
  // reducer-owned live entries, pending sends, or active runs as history.
  const scopedProjection = bindsScope
    ? { ...current, scope: { ...current.scope, ...scope } }
    : current;
  const currentMessagesMatch =
    scopedProjection.messages.length === messages.length &&
    scopedProjection.messages.every((message, index) => message === messages[index]);
  const projection = currentMessagesMatch
    ? scopedProjection
    : reconcileSessionProjectionSnapshot(scopedProjection, messages, scope);
  if (projection !== current) {
    setChatSessionProjection(owner, projection);
  }
  return projection;
}

export function getChatRunOwner(owner: object): string | undefined {
  return chatRunOwners.get(owner);
}

export function setChatRunOwner(owner: object, runId: string | undefined): void {
  if (runId === undefined) {
    chatRunOwners.delete(owner);
  } else {
    chatRunOwners.set(owner, runId);
  }
}

export function setChatSessionProjection(owner: object, projection: SessionProjectionState): void {
  const current = chatSessionProjections.get(owner);
  const runId = chatRunOwners.get(owner);
  if (
    runId !== undefined &&
    (!Object.hasOwn(projection.runs, runId) ||
      (current && chatProjectionScopeChanged(current.scope, projection.scope)))
  ) {
    chatRunOwners.delete(owner);
  }
  chatSessionProjections.set(owner, projection);
}

/** Publish one exact live transcript order without dropping reducer-owned entry identity. */
export function publishChatSessionProjectionMessages(
  owner: ChatSessionProjectionOwner,
  messages: readonly unknown[],
  options: {
    event?: SessionProjectionEvent;
    retainSupersededMessages?: boolean;
    scope?: SessionProjectionScope;
  } = {},
): SessionProjectionState {
  const scope = options.scope ?? readChatSessionProjectionScope(owner);
  const base = getChatSessionProjection(owner, owner.chatMessages, scope);
  const current = options.event ? reduceSessionProjection(base, { ...options.event, scope }) : base;
  const eventMessage = options.event?.type === "messagePersisted" ? options.event.message : null;
  const currentMessages = new Set(current.entries.map((entry) => entry.message));
  const supersededMessages = options.retainSupersededMessages
    ? new Set<unknown>()
    : new Set(
        base.entries
          .filter((entry) => !currentMessages.has(entry.message))
          .map((entry) => entry.message),
      );
  const eventAccepted = eventMessage === null || currentMessages.has(eventMessage);
  const acceptedMessages: unknown[] = [];
  let eventPublished = false;
  for (const message of messages) {
    if (supersededMessages.has(message)) {
      if (eventAccepted && eventMessage !== null && !eventPublished) {
        acceptedMessages.push(eventMessage);
        eventPublished = true;
      }
      continue;
    }
    if (message === eventMessage) {
      if (!eventAccepted || eventPublished) {
        continue;
      }
      eventPublished = true;
    }
    acceptedMessages.push(message);
  }
  const remainingEntries = [...current.entries];
  const seeded = createSessionProjection(scope, acceptedMessages);
  const entries = seeded.entries.map((seededEntry) => {
    const existingIndex = remainingEntries.findIndex(
      (entry) => entry.message === seededEntry.message,
    );
    if (existingIndex < 0) {
      return seededEntry;
    }
    return remainingEntries.splice(existingIndex, 1)[0] ?? seededEntry;
  });
  const projection: SessionProjectionState = {
    ...current,
    scope: { ...current.scope, ...scope },
    entries,
    messages: entries.map((entry) => entry.message),
  };
  setChatSessionProjection(owner, projection);
  owner.chatMessages = [...projection.messages];
  return projection;
}

/** Reuse one submission's retained display bytes, without borrowing its local metadata. */
export function adoptInitialUserMessage(
  message: unknown,
  handoff: InitialUserMessageHandoffEntry,
  submissionId: string | null | undefined,
): unknown {
  const identity = readSessionMessageIdentity(message);
  if (identity?.role !== "user" || identity.isImported || submissionId !== handoff.pendingRunId) {
    return message;
  }
  const authoritative = asNullableRecord(message) ?? {};
  // Inline content replaces the managed-media display carrier; rendering both
  // would duplicate the attachment. The received authoritative object is untouched.
  const { media: _media, ...authoritativeMetadata } =
    asNullableRecord(authoritative["__openclaw"]) ?? {};
  return {
    ...handoff.message,
    ...authoritative,
    content: handoff.message.content,
    __openclaw: authoritativeMetadata,
  };
}

/** Admit an accepted create-time prompt through the same reducer as ordinary sends. */
export function admitInitialUserMessageHandoff(
  owner: ChatSessionProjectionOwner,
  sessionKey: string,
): boolean {
  const handoff = owner.initialUserMessage?.read(sessionKey, owner.client ?? null);
  if (!handoff?.pending) {
    return false;
  }
  const scope = readChatSessionProjectionScope(owner, { sessionKey });
  const previousMessages = owner.chatMessages;
  reduceChatSessionProjection(
    owner,
    { type: "sendPending", runId: handoff.pendingRunId, message: handoff.message },
    { scope },
  );
  return owner.chatMessages !== previousMessages;
}

/** Publish the reducer and rendered transcript together; no caller maintains a second copy. */
export function reduceChatSessionProjection(
  owner: ChatSessionProjectionOwner,
  event: SessionProjectionEvent,
  options: {
    scope?: SessionProjectionScope;
    messages?: readonly unknown[];
    runActive?: boolean;
  } = {},
): SessionProjectionState {
  const scope = options.scope ?? readChatSessionProjectionScope(owner);
  const current = getChatSessionProjection(owner, options.messages ?? owner.chatMessages, scope);
  const sessionKey = scope.sessionKey ?? owner.sessionKey;
  const handoff = owner.initialUserMessage?.read(sessionKey, owner.client ?? null) ?? null;
  let adopted = false;
  const adopt = (message: unknown, envelope?: SessionMessageEnvelope) => {
    const next = handoff
      ? adoptInitialUserMessage(
          message,
          handoff,
          readSessionMessageIdentity(message, envelope)?.sendId,
        )
      : message;
    adopted ||= next !== message;
    return next;
  };
  const preparedEvent =
    event.type === "messagePersisted" && handoff
      ? { ...event, message: adopt(event.message, event.envelope ?? event) }
      : event.type === "snapshotLoaded" && handoff
        ? { ...event, messages: event.messages.map((message) => adopt(message)) }
        : event;
  let projection = current;
  if (
    event.type === "snapshotLoaded" &&
    handoff?.pending &&
    !adopted &&
    options.runActive !== false
  ) {
    projection = reduceSessionProjection(projection, {
      type: "sendPending",
      runId: handoff.pendingRunId,
      message: handoff.message,
      scope,
    });
  }
  projection = reduceSessionProjection(projection, { ...preparedEvent, scope });
  // Without a transcript anchor this is best-effort display chronology, assuming
  // comparable browser/Gateway clocks. Never assign a sequence or reorder canonical
  // rows; older or untimestamped history stays ahead until authoritative adoption.
  const initialIndex = handoff?.pending
    ? projection.entries.findIndex(
        (entry) => entry.pending && entry.pendingRunId === handoff.pendingRunId,
      )
    : -1;
  const initial = projection.entries[initialIndex];
  if (handoff && initial && initialIndex > 0) {
    const outputIndex = projection.entries.findIndex((entry, index) => {
      const message = asNullableRecord(entry.message);
      return (
        index < initialIndex &&
        message?.role !== "user" &&
        typeof message?.timestamp === "number" &&
        message.timestamp >= handoff.message.timestamp
      );
    });
    if (outputIndex >= 0) {
      const entries = projection.entries.toSpliced(initialIndex, 1);
      entries.splice(outputIndex, 0, initial);
      projection = { ...projection, entries, messages: entries.map((entry) => entry.message) };
    }
  }
  const renderedMessagesMatch =
    owner.chatMessages.length === projection.messages.length &&
    owner.chatMessages.every((message, index) => message === projection.messages[index]);
  if (projection !== current) {
    setChatSessionProjection(owner, projection);
  }
  if (!renderedMessagesMatch) {
    owner.chatMessages = [...projection.messages];
  }
  if (adopted && handoff) {
    owner.initialUserMessage?.retire(sessionKey, owner.client ?? null, handoff.pendingRunId);
  }
  if (handoff && !handoff.pending && options.runActive === false) {
    owner.initialUserMessage?.clear(sessionKey);
  }
  return projection;
}

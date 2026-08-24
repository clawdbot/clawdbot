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

/** One pane owns its shared-reducer projection; split panes never share live state. */
export function getChatSessionProjection(
  owner: object,
  messages: readonly unknown[] = [],
  scope: SessionProjectionScope = {},
): SessionProjectionState {
  const current = chatSessionProjections.get(owner);
  const scopeChanged =
    current !== undefined &&
    (
      ["sessionKey", "sessionId", "agentId", "lifecycleRevision", "activeLeafEntryId"] as const
    ).some((key) => {
      if (!Object.hasOwn(scope, key)) {
        return false;
      }
      const previous = current.scope[key];
      return previous !== undefined && previous !== scope[key];
    });
  if (!current || scopeChanged) {
    const projection = createSessionProjection(scope, messages);
    chatSessionProjections.set(owner, projection);
    return projection;
  }

  const bindsScope = (
    ["sessionKey", "sessionId", "agentId", "lifecycleRevision", "activeLeafEntryId"] as const
  ).some(
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
    chatSessionProjections.set(owner, projection);
  }
  return projection;
}

export function setChatSessionProjection(owner: object, projection: SessionProjectionState): void {
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

function adoptInitialUserMessage(
  message: unknown,
  envelope: SessionMessageEnvelope | undefined,
  handoff: InitialUserMessageHandoffEntry,
): unknown {
  const identity = readSessionMessageIdentity(message, envelope);
  const handoffSequence = handoff.message["__openclaw"]?.seq ?? null;
  if (
    identity?.role !== "user" ||
    identity.isImported ||
    identity.runId !== handoff.pendingRunId ||
    (handoffSequence !== null && identity.sequence !== handoffSequence)
  ) {
    return message;
  }
  const authoritative = asNullableRecord(message) ?? {};
  const { media: _media, ...authoritativeMetadata } =
    asNullableRecord(authoritative["__openclaw"]) ?? {};
  return {
    ...handoff.message,
    ...authoritative,
    content: handoff.message.content,
    __openclaw: {
      ...handoff.message["__openclaw"],
      ...authoritativeMetadata,
    },
  };
}

/** Admit an accepted create-time prompt through the same reducer as ordinary sends. */
export function admitInitialUserMessageHandoff(
  owner: ChatSessionProjectionOwner,
  sessionKey: string,
): boolean {
  const handoff = owner.initialUserMessage?.read(sessionKey, owner.client ?? null);
  if (!handoff) {
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
    const next = handoff ? adoptInitialUserMessage(message, envelope, handoff) : message;
    adopted ||= next !== message;
    return next;
  };
  const preparedEvent =
    event.type === "messagePersisted"
      ? { ...event, message: adopt(event.message, event.envelope ?? event) }
      : event.type === "snapshotLoaded"
        ? { ...event, messages: event.messages.map((message) => adopt(message)) }
        : event;
  let projection = current;
  if (event.type === "snapshotLoaded" && handoff && !adopted && options.runActive !== false) {
    projection = reduceSessionProjection(projection, {
      type: "sendPending",
      runId: handoff.pendingRunId,
      message: handoff.message,
      scope,
    });
  }
  projection = reduceSessionProjection(projection, { ...preparedEvent, scope });
  const renderedMessagesMatch =
    owner.chatMessages.length === projection.messages.length &&
    owner.chatMessages.every((message, index) => message === projection.messages[index]);
  if (projection !== current) {
    setChatSessionProjection(owner, projection);
  }
  if (!renderedMessagesMatch) {
    owner.chatMessages = [...projection.messages];
  }
  if (adopted && options.runActive === false) {
    owner.initialUserMessage?.clear(sessionKey);
  }
  return projection;
}

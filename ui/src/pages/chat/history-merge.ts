import {
  createSessionProjection,
  reconcileSessionProjectionSnapshot,
  reduceSessionProjection,
  type SessionProjectionEvent,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";

const chatSessionProjections = new WeakMap<object, SessionProjectionState>();

type ChatSessionProjectionOwner = {
  sessionKey: string;
  chatMessages: unknown[];
  currentSessionId?: string | null;
  chatDisplayedLeafEntryId?: string | null;
};

type ChatSessionProjectionScopeOptions = Omit<SessionProjectionScope, "sessionId"> & {
  sessionId?: string | null;
};

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

/** Publish the reducer and rendered transcript together; no caller maintains a second copy. */
export function reduceChatSessionProjection(
  owner: ChatSessionProjectionOwner,
  event: SessionProjectionEvent,
  options: {
    scope?: SessionProjectionScope;
    messages?: readonly unknown[];
  } = {},
): SessionProjectionState {
  const scope = options.scope ?? readChatSessionProjectionScope(owner);
  const current = getChatSessionProjection(owner, options.messages ?? owner.chatMessages, scope);
  const projection = reduceSessionProjection(current, { ...event, scope });
  if (projection !== current) {
    setChatSessionProjection(owner, projection);
    owner.chatMessages = [...projection.messages];
  }
  return projection;
}

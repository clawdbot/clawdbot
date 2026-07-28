import {
  createSessionProjection,
  reconcileSessionProjectionSnapshot,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "@openclaw/gateway-client/browser";

const chatSessionProjections = new WeakMap<object, SessionProjectionState>();

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

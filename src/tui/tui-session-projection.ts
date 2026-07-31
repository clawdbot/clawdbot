import {
  createSessionProjection,
  readSessionMessageIdentity,
  readSessionMessageSequence,
  reduceSessionProjection,
  type SessionProjectionEvent,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "../../packages/gateway-client/src/session-projection.js";
import { agentSessionKeysMatchByRequestKey } from "../routing/session-key.js";
import { extractTextFromMessage } from "./tui-formatters.js";
import type {
  ChatEvent,
  SessionChangedEvent,
  SessionMessageEvent,
  TuiStateAccess,
} from "./tui-types.js";

function hasDisplayableNonTextSessionContent(message: unknown): boolean {
  if (!message || typeof message !== "object") {
    return false;
  }
  const record = message as Record<string, unknown>;
  if (typeof record.mediaUrl === "string" && record.mediaUrl.trim()) {
    return true;
  }
  if (
    Array.isArray(record.mediaUrls) &&
    record.mediaUrls.some((media) => typeof media === "string" && media.trim())
  ) {
    return true;
  }
  if (!Array.isArray(record.content)) {
    return false;
  }
  return record.content.some((block) => {
    if (!block || typeof block !== "object") {
      return false;
    }
    const type = (block as Record<string, unknown>).type;
    return typeof type === "string" && type !== "text" && type !== "thinking";
  });
}

/** Keep attachment-only and provider-diagnostic finals visible in the TUI. */
export function hasDisplayableTuiSessionFinal(event: ChatEvent, showThinking: boolean): boolean {
  if (typeof event.errorMessage === "string" && event.errorMessage.trim()) {
    return true;
  }
  if (!event.message) {
    return false;
  }
  return (
    extractTextFromMessage(event.message, { includeThinking: showThinking }).trim().length > 0 ||
    hasDisplayableNonTextSessionContent(event.message)
  );
}

/** Distinguish a legacy batch invalidation from an individually replayable message. */
export function isIdentityOnlyTuiSessionInvalidation(event: SessionChangedEvent): boolean {
  if (event.phase !== "message") {
    return false;
  }
  const changed = event as SessionChangedEvent & {
    message?: unknown;
    messageId?: unknown;
    messageSeq?: unknown;
  };
  return (
    changed.message === undefined &&
    !(typeof changed.messageId === "string" && changed.messageId.trim().length > 0) &&
    !(
      typeof changed.messageSeq === "number" &&
      Number.isSafeInteger(changed.messageSeq) &&
      changed.messageSeq > 0
    ) &&
    !(typeof event.runId === "string" && event.runId.trim().length > 0) &&
    !(typeof event.clientRunId === "string" && event.clientRunId.trim().length > 0)
  );
}

/** Provider-local imports require a complete source or persisted—not envelope—sequence. */
export function isReplayableTuiSessionMessage(event: SessionMessageEvent): boolean {
  const identity = readSessionMessageIdentity(event.message, event);
  return Boolean(
    identity &&
    (!identity.isImported ||
      identity.externalSource ||
      readSessionMessageSequence(event.message) !== null),
  );
}

/** Scope the shared transcript projection to the TUI's actual selected session. */
export function readTuiSessionProjectionScope(
  state: Pick<TuiStateAccess, "currentSessionKey" | "currentAgentId" | "currentSessionId">,
): SessionProjectionScope {
  return {
    sessionKey: state.currentSessionKey,
    agentId: state.currentAgentId,
    ...(state.currentSessionId ? { sessionId: state.currentSessionId } : {}),
  };
}

/** Keep event handlers, history, and optimistic sends on one selected-session projection. */
export function getTuiSessionProjection(state: TuiStateAccess): SessionProjectionState {
  const scope = readTuiSessionProjectionScope(state);
  const current = state.sessionProjection;
  if (
    current &&
    agentSessionKeysMatchByRequestKey(current.scope.sessionKey, scope.sessionKey) &&
    current.scope.agentId === scope.agentId &&
    (current.scope.sessionId === scope.sessionId ||
      (current.scope.sessionId === undefined && scope.sessionId !== undefined))
  ) {
    if (
      current.scope.sessionKey === scope.sessionKey &&
      current.scope.sessionId === scope.sessionId
    ) {
      return current;
    }
    // First history/live identity binds an already-selected epoch; it must not
    // discard optimistic turns, peer messages, or active run projections.
    const projection = { ...current, scope: { ...current.scope, ...scope } };
    state.sessionProjection = projection;
    return projection;
  }
  const projection = createSessionProjection(scope);
  state.sessionProjection = projection;
  return projection;
}

/** Apply durable facts to the same TUI-owned reducer observed by every client path. */
export function reduceTuiSessionProjection(
  state: TuiStateAccess,
  event: SessionProjectionEvent,
): SessionProjectionState {
  const projection = reduceSessionProjection(getTuiSessionProjection(state), event);
  state.sessionProjection = projection;
  return projection;
}

/** Retain the assistant reply actually rendered until authoritative history adopts it. */
export function projectTuiSessionFinal(
  state: TuiStateAccess,
  event: ChatEvent,
  finalText: string,
  hasStreamedText: boolean,
): void {
  if (
    state.sessionProjection?.runs[event.runId]?.stopReason === "error" ||
    (!hasStreamedText &&
      !hasDisplayableTuiSessionFinal({ ...event, errorMessage: undefined }, state.showThinking))
  ) {
    return;
  }
  const source =
    event.message && typeof event.message === "object" && !Array.isArray(event.message)
      ? (event.message as Record<string, unknown>)
      : {};
  const attachments = Array.isArray(source.content)
    ? source.content.filter((block) => {
        if (!block || typeof block !== "object") {
          return false;
        }
        const type = (block as { type?: unknown }).type;
        return type !== "text" && type !== "thinking";
      })
    : [];
  reduceTuiSessionProjection(state, {
    type: "messagePersisted",
    message: {
      ...source,
      role: "assistant",
      content: attachments.length ? [{ type: "text", text: finalText }, ...attachments] : finalText,
    },
    envelope: { runId: event.runId },
    scope: readTuiSessionProjectionScope(state),
  });
}

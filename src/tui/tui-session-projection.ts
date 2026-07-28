import {
  createSessionProjection,
  reduceSessionProjection,
  type SessionProjectionRun,
  type SessionProjectionScope,
  type SessionProjectionState,
} from "../../packages/gateway-client/src/session-projection.js";
import { extractTextFromMessage } from "./tui-formatters.js";
import type { ChatEvent, SessionChangedEvent, TuiStateAccess } from "./tui-types.js";

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

/** Public Gateway stop metadata takes precedence over legacy nested message fields. */
export function readResolvedTuiSessionStopReason(event: ChatEvent): string | undefined {
  const eventStopReason = (event as ChatEvent & { stopReason?: unknown }).stopReason;
  if (typeof eventStopReason === "string") {
    return eventStopReason;
  }
  const message = event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const messageStopReason = (message as Record<string, unknown>).stopReason;
  return typeof messageStopReason === "string" ? messageStopReason : undefined;
}

/** Map Gateway run events into the canonical browser-safe session reducer. */
export function reduceTuiSessionRunProjection(
  current: SessionProjectionState,
  event: ChatEvent,
  scope: SessionProjectionScope,
): { projection: SessionProjectionState; previousRun: SessionProjectionRun | undefined } {
  const projection =
    current.scope.sessionKey === scope.sessionKey &&
    current.scope.agentId === scope.agentId &&
    current.scope.sessionId === scope.sessionId
      ? current
      : createSessionProjection(scope);
  const previousRun = projection.runs[event.runId];
  if (event.state === "delta") {
    return {
      projection: reduceSessionProjection(projection, {
        type: "runDelta",
        runId: event.runId,
        ...(event.message === undefined ? {} : { message: event.message }),
        scope,
      }),
      previousRun,
    };
  }

  const eventRecord = event as ChatEvent & {
    errorKind?: unknown;
    yielded?: unknown;
  };
  const stopReason = readResolvedTuiSessionStopReason(event);
  const errorKind = typeof eventRecord.errorKind === "string" ? eventRecord.errorKind : undefined;
  const terminalStatus =
    event.state === "aborted"
      ? "aborted"
      : event.state === "error"
        ? errorKind === "timeout"
          ? "timeout"
          : "error"
        : eventRecord.yielded === true && stopReason === "end_turn"
          ? "yielded"
          : stopReason === "error"
            ? "error"
            : "completed";

  return {
    projection: reduceSessionProjection(projection, {
      type: "runTerminal",
      runId: event.runId,
      status: terminalStatus,
      ...(event.message === undefined ? {} : { message: event.message }),
      ...(stopReason === undefined ? {} : { stopReason }),
      ...(errorKind === undefined ? {} : { errorKind }),
      ...(event.errorMessage === undefined ? {} : { errorMessage: event.errorMessage }),
      scope,
    }),
    previousRun,
  };
}

import { readSessionMessageIdentity } from "@openclaw/gateway-client/browser";
import { areUiSessionKeysEquivalent } from "../../lib/sessions/session-key.ts";

const liveTerminalRunIds = new WeakMap<object, string>();
const authoritativeTerminals = new WeakMap<object, AuthoritativeTerminal>();

type AuthoritativeTerminal = {
  historyApplied: boolean;
  messageId: string;
  runId: string;
  sessionKey: string;
};

/** Associates a live terminal projection with its run without altering transcript bytes. */
export function rememberLiveTerminalRun(
  message: unknown,
  runId: string | null | undefined,
): unknown {
  if (runId && message && typeof message === "object") {
    liveTerminalRunIds.set(message, runId);
  }
  return message;
}

export function isLiveTerminalForRun(message: unknown, runId: string): boolean {
  return Boolean(
    message && typeof message === "object" && liveTerminalRunIds.get(message) === runId,
  );
}

export function rememberAuthoritativeTerminal(options: {
  event: {
    clientRunId?: string | null;
    hasActiveRun?: boolean | null;
    key: string;
    runId?: string | null;
  };
  host: object;
  matchesChat: boolean;
  payload: unknown;
  runIdBeforeApply: string | null;
}): void {
  const payload =
    options.payload && typeof options.payload === "object" && !Array.isArray(options.payload)
      ? (options.payload as Record<string, unknown>)
      : null;
  const identity = readSessionMessageIdentity(payload?.message, {
    messageId: payload?.messageId,
  });
  const messageId = identity?.role === "assistant" && !identity.isImported ? identity.id : null;
  if (
    !options.runIdBeforeApply ||
    !options.matchesChat ||
    options.event.hasActiveRun === true ||
    !messageId
  ) {
    return;
  }
  authoritativeTerminals.set(options.host, {
    historyApplied: false,
    messageId,
    runId: options.event.clientRunId ?? options.event.runId ?? options.runIdBeforeApply,
    sessionKey: options.event.key,
  });
}

export function reconcileAuthoritativeTerminalHistory<T>(options: {
  host: object;
  previousMessages: T[];
  sessionKey: string;
  visibleMessages: T[];
}): T[] {
  const terminal = authoritativeTerminals.get(options.host);
  const historyContainsTerminal = Boolean(
    terminal &&
    areUiSessionKeysEquivalent(terminal.sessionKey, options.sessionKey) &&
    options.visibleMessages.some((message) => {
      const identity = readSessionMessageIdentity(message);
      return (
        identity?.role === "assistant" && !identity.isImported && identity.id === terminal.messageId
      );
    }),
  );
  if (!terminal || !historyContainsTerminal) {
    return options.previousMessages;
  }
  authoritativeTerminals.set(options.host, { ...terminal, historyApplied: true });
  return options.previousMessages.filter(
    (message) => !isLiveTerminalForRun(message, terminal.runId),
  );
}

export function authoritativeHistoryAppliedForRun(host: object, runId: string): boolean {
  const terminal = authoritativeTerminals.get(host);
  return terminal?.runId === runId && terminal.historyApplied;
}

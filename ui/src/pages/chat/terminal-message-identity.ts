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

export function clearAuthoritativeTerminal(host: object): void {
  authoritativeTerminals.delete(host);
}

function readTerminalAssistantMessageIdentity(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const record = payload as Record<string, unknown>;
  const message = record.message;
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    (message as Record<string, unknown>).role !== "assistant"
  ) {
    return null;
  }
  return typeof record.messageId === "string" && record.messageId.trim() ? record.messageId : null;
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
  const messageId = readTerminalAssistantMessageIdentity(options.payload);
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

function messageOpenClawId(message: unknown): string | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const meta = (message as Record<string, unknown>)["__openclaw"];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    return null;
  }
  const value = (meta as Record<string, unknown>)["id"];
  return typeof value === "string" && value.trim() ? value : null;
}

export function reconcileAuthoritativeTerminalHistory<T>(options: {
  currentMessages: T[];
  host: object;
  previousMessages: T[];
  sessionKey: string;
  visibleMessages: T[];
}): { currentMessages: T[]; previousMessages: T[] } {
  const terminal = authoritativeTerminals.get(options.host);
  const historyContainsTerminal = Boolean(
    terminal &&
    areUiSessionKeysEquivalent(terminal.sessionKey, options.sessionKey) &&
    options.visibleMessages.some((message) => messageOpenClawId(message) === terminal.messageId),
  );
  if (!terminal || !historyContainsTerminal) {
    return options;
  }
  authoritativeTerminals.set(options.host, { ...terminal, historyApplied: true });
  return {
    currentMessages: options.currentMessages.filter(
      (message) => !isLiveTerminalForRun(message, terminal.runId),
    ),
    previousMessages: options.previousMessages.filter(
      (message) => !isLiveTerminalForRun(message, terminal.runId),
    ),
  };
}

export function authoritativeHistoryAppliedForRun(host: object, runId: string): boolean {
  const terminal = authoritativeTerminals.get(host);
  return terminal?.runId === runId && terminal.historyApplied;
}

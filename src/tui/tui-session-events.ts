// Routes Gateway and embedded events to the exact selected TUI conversation.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { agentSessionKeysMatchByRequestKey, parseAgentSessionKey } from "../routing/session-key.js";
import { extractTextFromMessage } from "./tui-formatters.js";
import type { SessionMessageEvent, TuiStateAccess } from "./tui-types.js";

type TuiSessionEvent = {
  sessionKey?: string;
  agentId?: string;
};

/** Reads the monotonic transcript position shared by persisted and live messages. */
export function readTuiTranscriptMessageSequence(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const marker = (message as Record<string, unknown>)["__openclaw"];
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) {
    return undefined;
  }
  const sequence = (marker as Record<string, unknown>).seq;
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0
    ? sequence
    : undefined;
}

/** Reads the durable user identity without mistaking another run's prompt for this one. */
export function readTuiSessionUserMessage(event: SessionMessageEvent): {
  text: string;
  messageId: string;
  runId?: string;
} | null {
  const message = event.message;
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const record = message as Record<string, unknown>;
  if (record.role !== "user") {
    return null;
  }
  const marker = record["__openclaw"];
  const metadata =
    marker && typeof marker === "object" && !Array.isArray(marker)
      ? (marker as Record<string, unknown>)
      : null;
  const sequence = event.messageSeq ?? metadata?.seq;
  const messageId =
    (typeof event.messageId === "string" && event.messageId.trim() ? event.messageId : undefined) ??
    (typeof metadata?.id === "string" && metadata.id.trim() ? metadata.id : undefined) ??
    (typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0
      ? `seq:${sequence}`
      : undefined);
  const text = extractTextFromMessage(record);
  if (!messageId || !text) {
    return null;
  }
  const clientRunId =
    typeof event.clientRunId === "string" && event.clientRunId.trim()
      ? event.clientRunId
      : undefined;
  const idempotencyValue = clientRunId ?? metadata?.idempotencyKey ?? record.idempotencyKey;
  const idempotencyKey =
    typeof idempotencyValue === "string" && idempotencyValue.trim() ? idempotencyValue : undefined;
  const runId = idempotencyKey?.endsWith(":user")
    ? idempotencyKey.slice(0, -":user".length)
    : idempotencyKey;
  return { messageId, text, ...(runId ? { runId } : {}) };
}

/** Preserves opaque peer IDs while guarding canonical, global, and alias ownership. */
export function matchesSelectedTuiSession(
  state: TuiStateAccess,
  event: TuiSessionEvent,
  options?: { requireAliasOwnership?: boolean },
): boolean {
  const eventSessionKey = event.sessionKey?.trim();
  if (!agentSessionKeysMatchByRequestKey(eventSessionKey, state.currentSessionKey)) {
    return false;
  }

  const parsedEvent = parseAgentSessionKey(eventSessionKey);
  const parsedSelection = parseAgentSessionKey(state.currentSessionKey);
  if (
    parsedEvent &&
    parsedSelection &&
    normalizeLowercaseStringOrEmpty(parsedEvent.agentId) !==
      normalizeLowercaseStringOrEmpty(parsedSelection.agentId)
  ) {
    return false;
  }

  const selectedAgentId = normalizeLowercaseStringOrEmpty(state.currentAgentId);
  const eventAgentId = normalizeLowercaseStringOrEmpty(event.agentId);
  const defaultAgentId = normalizeLowercaseStringOrEmpty(state.agentDefaultId);
  const isGlobalSession = normalizeLowercaseStringOrEmpty(eventSessionKey) === "global";
  const requiresExplicitOwner =
    isGlobalSession || (options?.requireAliasOwnership === true && !parsedEvent);

  if (!requiresExplicitOwner) {
    return true;
  }
  return eventAgentId ? eventAgentId === selectedAgentId : selectedAgentId === defaultAgentId;
}

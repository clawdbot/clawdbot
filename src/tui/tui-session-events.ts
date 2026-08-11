// Routes Gateway and embedded events to the exact selected TUI conversation.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import {
  readSessionMessageIdentity,
  readSessionMessageSequence,
} from "../../packages/gateway-client/src/session-projection.js";
import { agentSessionKeysMatchByRequestKey, parseAgentSessionKey } from "../routing/session-key.js";
import { extractTextFromMessage } from "./tui-formatters.js";
import type { SessionMessageEvent, TuiStateAccess } from "./tui-types.js";

type TuiSessionEvent = {
  sessionKey?: string;
  agentId?: string;
};

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
  const identity = readSessionMessageIdentity(message, event);
  if (identity?.role !== "user") {
    return null;
  }
  const persistedSequence = readSessionMessageSequence(message);
  // Imported IDs are provider-local. Namespace their complete source tuple or
  // persisted transcript position so incomplete imports cannot collide with native rows.
  const messageId = identity.isImported
    ? identity.externalSource
      ? `external:${identity.externalSource}`
      : persistedSequence !== null
        ? `imported-seq:${persistedSequence}`
        : null
    : (identity.id ?? (identity.sequence !== null ? `seq:${identity.sequence}` : null));
  const text = extractTextFromMessage(record);
  if (!messageId || !text) {
    return null;
  }
  return { messageId, text, ...(identity.runId ? { runId: identity.runId } : {}) };
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

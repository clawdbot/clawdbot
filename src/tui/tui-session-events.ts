// Routes Gateway and embedded events to the exact selected TUI conversation.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { agentSessionKeysMatchByRequestKey, parseAgentSessionKey } from "../routing/session-key.js";
import type { TuiStateAccess } from "./tui-types.js";

type TuiSessionEvent = {
  sessionKey?: string;
  agentId?: string;
};

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

import { resolveGlobalSingleton } from "../../shared/global-singleton.js";
import { normalizeActorKey } from "./manager.utils.js";

// Process-local liveness signal for in-flight ACP prompt turns, kept off the
// SDK-exported AcpSessionManager so plugins cannot read this maintenance-only
// state. Mirrors cron's active-jobs registry: task maintenance asks "is a turn
// still running for this session?" to avoid reclaiming a live run whose persisted
// session entry survived a crash. The AcpSessionManager marks/clears it in lockstep
// with its in-memory turn map.

type AcpActiveTurnState = {
  activeTurnKeys: Set<string>;
};

const ACP_ACTIVE_TURN_STATE_KEY = Symbol.for("openclaw.acp.activeTurns");

function getAcpActiveTurnState(): AcpActiveTurnState {
  return resolveGlobalSingleton<AcpActiveTurnState>(ACP_ACTIVE_TURN_STATE_KEY, () => ({
    activeTurnKeys: new Set<string>(),
  }));
}

export function markAcpTurnActive(sessionKey: string) {
  if (!sessionKey) {
    return;
  }
  getAcpActiveTurnState().activeTurnKeys.add(normalizeActorKey(sessionKey));
}

export function clearAcpTurnActive(sessionKey: string) {
  if (!sessionKey) {
    return;
  }
  getAcpActiveTurnState().activeTurnKeys.delete(normalizeActorKey(sessionKey));
}

export function isAcpTurnActive(sessionKey: string): boolean {
  if (!sessionKey) {
    return false;
  }
  return getAcpActiveTurnState().activeTurnKeys.has(normalizeActorKey(sessionKey));
}

export function resetAcpActiveTurnsForTests() {
  getAcpActiveTurnState().activeTurnKeys.clear();
}

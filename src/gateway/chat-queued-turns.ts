/**
 * Gateway-owned cancel identity for turns that have been admitted to the
 * followup/collect queue but are not yet (or no longer) active chat-send runs.
 *
 * Active runs stay in chatAbortControllers. Queued waits must NOT look like
 * active runs (projection, timeout ownership, terminal dedupe), but they must
 * remain abortable by authorized requesters after chat.send terminalizes.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";

export type QueuedChatTurnEntry = {
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  /** False once collect-mode transfers cancellation to the aggregate owner. */
  abortable?: boolean;
  agentId?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
};

export type QueuedChatTurnMap = Map<string, QueuedChatTurnEntry>;

export type RegisterQueuedChatTurnParams = {
  chatQueuedTurns: QueuedChatTurnMap;
  runId: string;
  controller: AbortController;
  sessionId: string;
  sessionKey: string;
  agentId?: string;
  ownerConnId?: string;
  ownerDeviceId?: string;
};

function resolveExactRunId(runId: string): string | undefined {
  // chat.send idempotency keys are exact protocol identities. Trimming here
  // would diverge from the active-run and dedupe registries.
  return runId.length > 0 ? runId : undefined;
}

// Queue callbacks can outlive their map entry, and protocol run IDs may be reused.
// Mutate only the exact entry captured by the callback or abort operation.
function deleteQueuedChatTurnEntry(
  chatQueuedTurns: QueuedChatTurnMap,
  runId: string,
  entry: QueuedChatTurnEntry,
): boolean {
  if (chatQueuedTurns.get(runId) !== entry) {
    return false;
  }
  return chatQueuedTurns.delete(runId);
}

export function registerQueuedChatTurn(params: RegisterQueuedChatTurnParams): boolean {
  const runId = resolveExactRunId(params.runId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!runId || !sessionKey) {
    return false;
  }
  if (params.controller.signal.aborted) {
    return false;
  }
  const existing = params.chatQueuedTurns.get(runId);
  if (existing && existing.controller === params.controller) {
    return true;
  }
  if (existing) {
    return false;
  }
  const entry: QueuedChatTurnEntry = {
    controller: params.controller,
    sessionId: params.sessionId,
    sessionKey,
    agentId: normalizeOptionalString(params.agentId)?.toLowerCase(),
    ownerConnId: normalizeOptionalString(params.ownerConnId),
    ownerDeviceId: normalizeOptionalString(params.ownerDeviceId),
  };
  params.chatQueuedTurns.set(runId, entry);
  params.controller.signal.addEventListener(
    "abort",
    () => {
      // Queued entries can outlive active-run cleanup. Retired collect entries
      // stay as idempotency guards until aggregate completion removes them.
      if (entry.abortable !== false) {
        deleteQueuedChatTurnEntry(params.chatQueuedTurns, runId, entry);
      }
    },
    { once: true },
  );
  return true;
}

export function completeQueuedChatTurn(
  chatQueuedTurns: QueuedChatTurnMap,
  runId: string,
  controller: AbortController,
): boolean {
  const key = resolveExactRunId(runId);
  if (!key) {
    return false;
  }
  const entry = chatQueuedTurns.get(key);
  return entry?.controller === controller
    ? deleteQueuedChatTurnEntry(chatQueuedTurns, key, entry)
    : false;
}

/**
 * Retain the live run identity for idempotency while transferring cancellation
 * to a collect aggregate. Completion still removes the entry.
 */
export function retireQueuedChatTurnCancellation(
  chatQueuedTurns: QueuedChatTurnMap,
  runId: string,
  controller: AbortController,
): boolean {
  const entry = getQueuedChatTurn(chatQueuedTurns, runId);
  if (!entry || entry.controller !== controller) {
    return false;
  }
  entry.abortable = false;
  return true;
}

export function getQueuedChatTurn(
  chatQueuedTurns: QueuedChatTurnMap,
  runId: string,
): QueuedChatTurnEntry | undefined {
  const key = resolveExactRunId(runId);
  if (!key) {
    return undefined;
  }
  return chatQueuedTurns.get(key);
}

/**
 * Abort a single queued turn by runId. Does not authorize; caller must check.
 * Returns false when missing or already aborted/removed.
 */
export function abortQueuedChatTurnById(
  chatQueuedTurns: QueuedChatTurnMap,
  params: {
    runId: string;
    sessionKey: string;
    stopReason?: string;
    /** When true, allow abort even if sessionKey does not match (owner already authorized). */
    allowSessionMismatch?: boolean;
  },
): { aborted: boolean } {
  const runId = resolveExactRunId(params.runId);
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!runId || !sessionKey) {
    return { aborted: false };
  }
  const entry = chatQueuedTurns.get(runId);
  if (!entry || entry.abortable === false) {
    return { aborted: false };
  }
  if (!params.allowSessionMismatch && entry.sessionKey !== sessionKey) {
    return { aborted: false };
  }
  if (!entry.controller.signal.aborted) {
    entry.controller.abort(
      params.stopReason ? new Error(`queued turn aborted: ${params.stopReason}`) : undefined,
    );
  }
  deleteQueuedChatTurnEntry(chatQueuedTurns, runId, entry);
  return { aborted: true };
}

export type QueuedChatTurnMatch = {
  runId: string;
  entry: QueuedChatTurnEntry;
};

/**
 * List queued turns matching session keys / session ids / optional agent scope.
 * Authorization is left to the caller.
 */
export function listQueuedChatTurnsForSession(params: {
  chatQueuedTurns: QueuedChatTurnMap;
  sessionKeys: Iterable<string>;
  sessionIds?: Iterable<string | undefined>;
  agentId?: string;
  defaultAgentId?: string;
}): QueuedChatTurnMatch[] {
  const sessionKeys = new Set(
    Array.from(params.sessionKeys, (k) => normalizeOptionalString(k)).filter((k): k is string =>
      Boolean(k),
    ),
  );
  const sessionIds = new Set(
    Array.from(params.sessionIds ?? [], (id) => normalizeOptionalString(id)).filter(
      (id): id is string => Boolean(id),
    ),
  );
  const agentId = normalizeOptionalString(params.agentId)?.toLowerCase();
  const defaultAgentId = normalizeOptionalString(params.defaultAgentId)?.toLowerCase();
  const matches: QueuedChatTurnMatch[] = [];
  for (const [runId, entry] of params.chatQueuedTurns) {
    if (entry.abortable === false) {
      continue;
    }
    if (!sessionKeys.has(entry.sessionKey) && !sessionIds.has(entry.sessionId)) {
      continue;
    }
    if (agentId && entry.sessionKey === "global") {
      const entryAgent = (entry.agentId ?? defaultAgentId)?.toLowerCase();
      if (entryAgent !== agentId) {
        continue;
      }
    }
    matches.push({ runId, entry });
  }
  return matches;
}

/**
 * Abort all provided queued turns (already authorized by caller).
 * Order: abort signals first, then remove from map, so drain cannot promote mid-loop.
 */
export function abortQueuedChatTurns(
  chatQueuedTurns: QueuedChatTurnMap,
  matches: readonly QueuedChatTurnMatch[],
  stopReason?: string,
): string[] {
  const runIds: string[] = [];
  for (const { runId, entry } of matches) {
    if (chatQueuedTurns.get(runId) !== entry) {
      continue;
    }
    if (!entry.controller.signal.aborted) {
      entry.controller.abort(
        stopReason ? new Error(`queued turn aborted: ${stopReason}`) : undefined,
      );
    }
    deleteQueuedChatTurnEntry(chatQueuedTurns, runId, entry);
    runIds.push(runId);
  }
  return runIds;
}

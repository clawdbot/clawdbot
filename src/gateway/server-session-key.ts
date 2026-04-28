import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import { getAgentRunContext, registerAgentRunContext } from "../infra/agent-events.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { loadCombinedSessionStoreForGateway } from "./session-utils.js";

const RUN_LOOKUP_CACHE_LIMIT = 256;
const RUN_LOOKUP_MISS_TTL_MS = 1_000;

type RunLookupCacheEntry = {
  sessionKey: string | null;
  expiresAt: number | null;
};

const resolvedSessionKeyByRunId = new Map<string, RunLookupCacheEntry>();

function setResolvedSessionKeyCache(runId: string, sessionKey: string | null): void {
  if (!runId) {
    return;
  }
  if (
    !resolvedSessionKeyByRunId.has(runId) &&
    resolvedSessionKeyByRunId.size >= RUN_LOOKUP_CACHE_LIMIT
  ) {
    const oldest = resolvedSessionKeyByRunId.keys().next().value;
    if (oldest) {
      resolvedSessionKeyByRunId.delete(oldest);
    }
  }
  resolvedSessionKeyByRunId.set(runId, {
    sessionKey,
    expiresAt: sessionKey === null ? Date.now() + RUN_LOOKUP_MISS_TTL_MS : null,
  });
}

export function resolveSessionKeyForRun(runId: string) {
  const cached = getAgentRunContext(runId)?.sessionKey;
  if (cached) {
    return cached;
  }
  const cachedLookup = resolvedSessionKeyByRunId.get(runId);
  if (cachedLookup !== undefined) {
    if (cachedLookup.sessionKey !== null) {
      return cachedLookup.sessionKey;
    }
    if ((cachedLookup.expiresAt ?? 0) > Date.now()) {
      return undefined;
    }
    resolvedSessionKeyByRunId.delete(runId);
  }
  const cfg = getRuntimeConfig();
  const { store } = loadCombinedSessionStoreForGateway(cfg);
  const matches = Object.entries(store).filter(
    (entry): entry is [string, SessionEntry] => entry[1]?.sessionId === runId,
  );
  const storeKey = resolvePreferredSessionKeyForSessionIdMatches(matches, runId);
  if (storeKey) {
    const sessionKey = toAgentRequestSessionKey(storeKey) ?? storeKey;
    registerAgentRunContext(runId, { sessionKey });
    setResolvedSessionKeyCache(runId, sessionKey);
    return sessionKey;
  }
  setResolvedSessionKeyCache(runId, null);
  return undefined;
}

export function resetResolvedSessionKeyForRunCacheForTest(): void {
  resolvedSessionKeyByRunId.clear();
}

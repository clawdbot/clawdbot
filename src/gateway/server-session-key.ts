import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getRuntimeConfig } from "../config/io.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import {
  normalizeAgentId,
  parseAgentSessionKey,
  toAgentRequestSessionKey,
} from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "./session-store-key.js";
import { loadCombinedSessionStoreForGateway } from "./session-utils.js";

const RUN_LOOKUP_CACHE_LIMIT = 256;
const RUN_LOOKUP_MISS_TTL_MS = 1_000;

type RunLookupCacheEntry = {
  sessionKey: string | null;
  expiresAt: number | null;
};

const resolvedSessionKeyByRunId = new Map<string, RunLookupCacheEntry>();

function runLookupCacheKey(runId: string, agentId: string): string {
  return `${agentId}\0${runId}`;
}

function setResolvedSessionKeyCache(
  runId: string,
  agentId: string,
  sessionKey: string | null,
): void {
  if (!runId) {
    return;
  }
  const cacheKey = runLookupCacheKey(runId, agentId);
  if (
    !resolvedSessionKeyByRunId.has(cacheKey) &&
    resolvedSessionKeyByRunId.size >= RUN_LOOKUP_CACHE_LIMIT
  ) {
    const oldest = resolvedSessionKeyByRunId.keys().next().value;
    if (oldest) {
      resolvedSessionKeyByRunId.delete(oldest);
    }
  }
  resolvedSessionKeyByRunId.set(cacheKey, {
    sessionKey,
    expiresAt: sessionKey === null ? Date.now() + RUN_LOOKUP_MISS_TTL_MS : null,
  });
}

function sessionKeyMatchesAgent(sessionKey: string, agentId: string, cfg: OpenClawConfig): boolean {
  if (cfg.session?.scope === "global" && sessionKey.trim().toLowerCase() === "global") {
    return true;
  }
  const normalizedAgentId = normalizeAgentId(agentId);
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed && sessionKey.trim().toLowerCase().startsWith("agent:")) {
    return false;
  }
  const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey, storeAgentId: agentId });
  return resolveSessionStoreAgentId(cfg, canonicalKey) === normalizedAgentId;
}

function resolveRunSessionKeyForCaller(storeKey: string) {
  return toAgentRequestSessionKey(storeKey) ?? storeKey;
}

export function resolveSessionKeyForRun(runId: string, opts: { agentId?: string } = {}) {
  const cfg = getRuntimeConfig();
  const explicitAgentId =
    typeof opts.agentId === "string" && opts.agentId.trim()
      ? normalizeAgentId(opts.agentId)
      : undefined;
  const cached = getAgentRunContext(runId)?.sessionKey;
  if (!explicitAgentId && cached) {
    return cached;
  }
  const requestedAgentId = explicitAgentId ?? normalizeAgentId(resolveDefaultAgentId(cfg));
  const cacheAgentId = requestedAgentId;
  if (cached && sessionKeyMatchesAgent(cached, requestedAgentId, cfg)) {
    const sessionKey = resolveRunSessionKeyForCaller(cached);
    setResolvedSessionKeyCache(runId, cacheAgentId, sessionKey);
    return sessionKey;
  }
  const cacheKey = runLookupCacheKey(runId, cacheAgentId);
  const cachedLookup = resolvedSessionKeyByRunId.get(cacheKey);
  if (cachedLookup !== undefined) {
    if (cachedLookup.sessionKey !== null) {
      return cachedLookup.sessionKey;
    }
    if ((cachedLookup.expiresAt ?? 0) > Date.now()) {
      return undefined;
    }
    resolvedSessionKeyByRunId.delete(cacheKey);
  }
  const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId: requestedAgentId });
  const matches = Object.entries(store).filter(
    (entry): entry is [string, SessionEntry] =>
      entry[1]?.sessionId === runId && sessionKeyMatchesAgent(entry[0], requestedAgentId, cfg),
  );
  const storeKey = resolvePreferredSessionKeyForSessionIdMatches(matches, runId);
  if (storeKey) {
    const sessionKey = resolveRunSessionKeyForCaller(storeKey);
    setResolvedSessionKeyCache(runId, cacheAgentId, sessionKey);
    return sessionKey;
  }
  setResolvedSessionKeyCache(runId, cacheAgentId, null);
  return undefined;
}

export function resetResolvedSessionKeyForRunCacheForTest(): void {
  resolvedSessionKeyByRunId.clear();
}

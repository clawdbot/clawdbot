/**
 * Subagent spawn-depth lookup helpers.
 *
 * Reads persisted session store state to recover spawn depth and parent lineage across restarts.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveStorePath } from "../config/sessions/paths.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseStrictNonNegativeInteger } from "../infra/parse-finite-number.js";
import { getSubagentDepth, parseAgentSessionKey } from "../sessions/session-key-utils.js";
import { resolveDefaultAgentId } from "./agent-scope.js";

type SessionDepthEntry = {
  sessionId?: unknown;
  spawnDepth?: unknown;
  spawnedBy?: unknown;
};

function normalizeSpawnDepth(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    return parseStrictNonNegativeInteger(value);
  }
  return undefined;
}

function readSessionStore(storePath: string, agentId: string): Record<string, SessionDepthEntry> {
  try {
    return Object.fromEntries(
      listSessionEntriesReadOnly({ agentId, storePath, clone: false }).map(
        ({ sessionKey, entry }) => [sessionKey, entry],
      ),
    );
  } catch {
    // ignore missing/unavailable stores
  }
  return {};
}

function buildKeyCandidates(rawKey: string, cfg?: OpenClawConfig): string[] {
  if (!cfg) {
    return [rawKey];
  }
  if (rawKey === "global" || rawKey === "unknown") {
    return [rawKey];
  }
  if (parseAgentSessionKey(rawKey)) {
    return [rawKey];
  }
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const prefixed = `agent:${defaultAgentId}:${rawKey}`;
  return prefixed === rawKey ? [rawKey] : [rawKey, prefixed];
}

function findEntryBySessionId(
  store: Record<string, SessionDepthEntry>,
  sessionId: string,
): SessionDepthEntry | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  for (const entry of Object.values(store)) {
    const candidateSessionId = normalizeOptionalString(entry?.sessionId);
    if (candidateSessionId && candidateSessionId === normalizedSessionId) {
      return entry;
    }
  }
  return undefined;
}

function resolveEntryForSessionKey(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  store?: Record<string, SessionDepthEntry>;
  cache: Map<string, Record<string, SessionDepthEntry>>;
}): SessionDepthEntry | undefined {
  const candidates = buildKeyCandidates(params.sessionKey, params.cfg);

  if (params.store) {
    for (const key of candidates) {
      const entry = params.store[key];
      if (entry) {
        return entry;
      }
    }
    const entry = findEntryBySessionId(params.store, params.sessionKey);
    if (entry || !params.cfg) {
      return entry;
    }
  }

  if (!params.cfg) {
    return undefined;
  }

  for (const key of candidates) {
    const parsed = parseAgentSessionKey(key);
    if (!parsed?.agentId) {
      continue;
    }
    const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed.agentId });
    let store = params.cache.get(storePath);
    if (!store) {
      store = readSessionStore(storePath, parsed.agentId);
      params.cache.set(storePath, store);
    }
    const entry = store[key] ?? findEntryBySessionId(store, params.sessionKey);
    if (entry) {
      return entry;
    }
  }

  return undefined;
}

export function getSubagentDepthFromSessionStore(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: Record<string, SessionDepthEntry>;
  },
): number {
  const raw = (sessionKey ?? "").trim();
  const fallbackDepth = getSubagentDepth(raw);
  if (!raw) {
    return fallbackDepth;
  }

  const cache = new Map<string, Record<string, SessionDepthEntry>>();
  const visited = new Set<string>();

  const depthFromStore = (key: string): number | undefined => {
    const normalizedKey = normalizeOptionalString(key);
    if (!normalizedKey) {
      return undefined;
    }
    if (visited.has(normalizedKey)) {
      return undefined;
    }
    visited.add(normalizedKey);

    const entry = resolveEntryForSessionKey({
      sessionKey: normalizedKey,
      cfg: opts?.cfg,
      store: opts?.store,
      cache,
    });

    const storedDepth = normalizeSpawnDepth(entry?.spawnDepth);
    if (storedDepth !== undefined) {
      return storedDepth;
    }

    // Only spawnedBy is spawn lineage. parentSessionKey is UI threading
    // (dashboard auto-parenting, forks, checkpoints) and must never add depth;
    // sessions.create persists explicit spawnDepth for every fresh entry.
    // Accepted tradeoff: pre-upgrade visible children carried lineage only via
    // parentSessionKey and now resolve as roots; that transient population may
    // spawn one extra generation (still capped by maxChildrenPerAgent), which
    // beats permanently misclassifying operator sessions as depth-1 leaves.
    const parentKey = normalizeOptionalString(entry?.spawnedBy);
    if (!parentKey) {
      return undefined;
    }

    const parentDepth = depthFromStore(parentKey);
    if (parentDepth !== undefined) {
      return parentDepth + 1;
    }

    return getSubagentDepth(parentKey) + 1;
  };

  return depthFromStore(raw) ?? fallbackDepth;
}

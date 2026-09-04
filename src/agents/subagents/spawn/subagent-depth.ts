import { parseStrictNonNegativeInteger } from "@openclaw/normalization-core/number-coercion";
/**
 * Subagent spawn-depth lookup helpers.
 *
 * Reads persisted session store state to recover spawn depth and parent lineage across restarts.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveSessionStorePathCore } from "../../../config/sessions/paths.js";
import { listSessionEntriesReadOnly } from "../../../config/sessions/session-accessor.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { normalizeAgentId } from "../../../routing/session-key.js";
import { getSubagentDepth, parseAgentSessionKey } from "../../../sessions/session-key-utils.js";
import { resolveSessionAgentId } from "../../agent-scope.js";

type PersistedSessionDepthEntry = Pick<SessionEntry, "sessionId" | "spawnDepth" | "spawnedBy">;
type SessionDepthEntry = { [Key in keyof PersistedSessionDepthEntry]?: unknown };

function normalizeSpawnDepth(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === "string") {
    return parseStrictNonNegativeInteger(value);
  }
  return undefined;
}

export function readSubagentSessionStore(
  storePath: string,
  agentId: string,
): Record<string, SessionEntry> {
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

function buildKeyCandidates(
  rawKey: string,
  cfg?: OpenClawConfig,
  explicitAgentId?: string,
): string[] {
  if (!cfg) {
    return [rawKey];
  }
  if (rawKey === "unknown") {
    return [rawKey];
  }
  if (parseAgentSessionKey(rawKey)) {
    return [rawKey];
  }
  const agentId = resolveSessionAgentId({
    sessionKey: rawKey,
    config: cfg,
    agentId: explicitAgentId,
  });
  const prefixed = `agent:${agentId}:${rawKey}`;
  return prefixed === rawKey ? [rawKey] : [rawKey, prefixed];
}

export function findSubagentSessionEntryById<T extends SessionDepthEntry>(
  store: Record<string, T>,
  sessionId: string,
): T | undefined {
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
  cache: Map<string, Record<string, SessionEntry>>;
  agentId?: string;
}): SessionDepthEntry | undefined {
  const candidates = buildKeyCandidates(params.sessionKey, params.cfg, params.agentId);

  if (params.store) {
    for (const key of candidates) {
      const entry = params.store[key];
      if (entry) {
        return entry;
      }
    }
    const entry = findSubagentSessionEntryById(params.store, params.sessionKey);
    if (entry || !params.cfg) {
      return entry;
    }
  }

  if (!params.cfg) {
    return undefined;
  }

  const candidateAgentIds = new Set(
    candidates.flatMap((key) => {
      const agentId = parseAgentSessionKey(key)?.agentId;
      return agentId ? [agentId] : [];
    }),
  );
  for (const agentId of candidateAgentIds) {
    const storePath = resolveSessionStorePathCore(params.cfg.session?.store, { agentId });
    // A fixed path still exposes an agent-scoped logical view. Reusing another
    // agent's snapshot can erase cross-agent lineage or adopt the wrong row.
    const cacheKey = `${storePath}\0${normalizeAgentId(agentId)}`;
    let store = params.cache.get(cacheKey);
    if (!store) {
      store = readSubagentSessionStore(storePath, agentId);
      params.cache.set(cacheKey, store);
    }
    const entry =
      candidates.map((key) => store[key]).find((candidate) => candidate !== undefined) ??
      findSubagentSessionEntryById(store, params.sessionKey);
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
    agentId?: string;
  },
): number {
  const raw = (sessionKey ?? "").trim();
  const fallbackDepth = getSubagentDepth(raw);
  if (!raw) {
    return fallbackDepth;
  }

  const cache = new Map<string, Record<string, SessionEntry>>();
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
      agentId: opts?.agentId,
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

import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { normalizeSubagentSessionKey } from "./subagent-session-key.js";

export const SUBAGENT_SESSION_ROLES = ["main", "orchestrator", "leaf"] as const;
export type SubagentSessionRole = (typeof SUBAGENT_SESSION_ROLES)[number];

export const SUBAGENT_CONTROL_SCOPES = ["children", "none"] as const;
export type SubagentControlScope = (typeof SUBAGENT_CONTROL_SCOPES)[number];

export type SessionCapabilityEntry = {
  sessionId?: unknown;
  spawnDepth?: unknown;
  subagentRole?: unknown;
  subagentControlScope?: unknown;
  spawnedBy?: unknown;
};

export type SessionCapabilityStore = Record<string, SessionCapabilityEntry>;

function normalizeSubagentRole(value: unknown): SubagentSessionRole | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_SESSION_ROLES.find((entry) => entry === trimmed);
}

function normalizeSubagentControlScope(value: unknown): SubagentControlScope | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_CONTROL_SCOPES.find((entry) => entry === trimmed);
}

function shouldInspectStoredSubagentEnvelope(sessionKey: string): boolean {
  return isSubagentSessionKey(sessionKey) || isAcpSessionKey(sessionKey);
}

function isSameAgentSessionStore(leftSessionKey: string, rightSessionKey: string): boolean {
  const leftAgentId = normalizeOptionalLowercaseString(
    parseAgentSessionKey(leftSessionKey)?.agentId,
  );
  const rightAgentId = normalizeOptionalLowercaseString(
    parseAgentSessionKey(rightSessionKey)?.agentId,
  );
  return Boolean(leftAgentId) && leftAgentId === rightAgentId;
}

function readSessionStore(storePath: string): Record<string, SessionCapabilityEntry> {
  try {
    return loadSessionStore(storePath);
  } catch {
    return {};
  }
}

function findEntryBySessionId(
  store: SessionCapabilityStore,
  sessionId: string,
): SessionCapabilityEntry | undefined {
  const normalizedSessionId = normalizeSubagentSessionKey(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  for (const entry of Object.values(store)) {
    const candidateSessionId = normalizeSubagentSessionKey(entry?.sessionId);
    if (candidateSessionId === normalizedSessionId) {
      return entry;
    }
  }
  return undefined;
}

function resolveSessionCapabilityEntry(params: {
  sessionKey: string;
  cfg?: OpenClawConfig;
  store?: SessionCapabilityStore;
}): SessionCapabilityEntry | undefined {
  if (params.store) {
    return params.store[params.sessionKey] ?? findEntryBySessionId(params.store, params.sessionKey);
  }
  if (!params.cfg) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(params.sessionKey);
  if (!parsed?.agentId) {
    return undefined;
  }
  const storePath = resolveStorePath(params.cfg.session?.store, { agentId: parsed.agentId });
  const store = readSessionStore(storePath);
  return store[params.sessionKey] ?? findEntryBySessionId(store, params.sessionKey);
}

export function resolveSubagentCapabilityStore(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
  },
): SessionCapabilityStore | undefined {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  if (!normalizedSessionKey) {
    return opts?.store;
  }
  if (opts?.store) {
    return opts.store;
  }
  if (!opts?.cfg || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
    return undefined;
  }
  const parsed = parseAgentSessionKey(normalizedSessionKey);
  if (!parsed?.agentId) {
    return undefined;
  }
  const storePath = resolveStorePath(opts.cfg.session?.store, { agentId: parsed.agentId });
  return readSessionStore(storePath);
}

export function resolveSubagentRoleForDepth(params: {
  depth: number;
  maxSpawnDepth?: number;
}): SubagentSessionRole {
  const depth = Number.isInteger(params.depth) ? Math.max(0, params.depth) : 0;
  const maxSpawnDepth =
    typeof params.maxSpawnDepth === "number" && Number.isFinite(params.maxSpawnDepth)
      ? Math.max(1, Math.floor(params.maxSpawnDepth))
      : DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (depth <= 0) {
    return "main";
  }
  return depth < maxSpawnDepth ? "orchestrator" : "leaf";
}

export function resolveSubagentControlScopeForRole(
  role: SubagentSessionRole,
): SubagentControlScope {
  return role === "leaf" ? "none" : "children";
}

export function resolveSubagentCapabilities(params: { depth: number; maxSpawnDepth?: number }) {
  const role = resolveSubagentRoleForDepth(params);
  const controlScope = resolveSubagentControlScopeForRole(role);
  return {
    depth: Math.max(0, Math.floor(params.depth)),
    role,
    controlScope,
    canSpawn: role === "main" || role === "orchestrator",
    canControlChildren: controlScope === "children",
  };
}

function isStoredSubagentEnvelopeSession(
  params: {
    sessionKey: string;
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    entry?: SessionCapabilityEntry;
  },
  visited = new Set<string>(),
): boolean {
  const normalizedSessionKey = normalizeSubagentSessionKey(params.sessionKey);
  if (!normalizedSessionKey || visited.has(normalizedSessionKey)) {
    return false;
  }
  visited.add(normalizedSessionKey);

  if (isSubagentSessionKey(normalizedSessionKey)) {
    return true;
  }
  if (!isAcpSessionKey(normalizedSessionKey)) {
    return false;
  }

  const entry =
    params.entry ??
    resolveSessionCapabilityEntry({
      sessionKey: normalizedSessionKey,
      cfg: params.cfg,
      store: params.store,
    });
  if (
    normalizeSubagentRole(entry?.subagentRole) ||
    normalizeSubagentControlScope(entry?.subagentControlScope)
  ) {
    return true;
  }

  const spawnedBy = normalizeSubagentSessionKey(entry?.spawnedBy);
  if (!spawnedBy) {
    return false;
  }
  const parentStore = isSameAgentSessionStore(normalizedSessionKey, spawnedBy)
    ? params.store
    : undefined;
  return isStoredSubagentEnvelopeSession(
    {
      sessionKey: spawnedBy,
      cfg: params.cfg,
      store: parentStore,
    },
    visited,
  );
}

export function isSubagentEnvelopeSession(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
    entry?: SessionCapabilityEntry;
  },
): boolean {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  if (!normalizedSessionKey) {
    return false;
  }
  if (isSubagentSessionKey(normalizedSessionKey)) {
    return true;
  }
  if (!isAcpSessionKey(normalizedSessionKey)) {
    return false;
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  return isStoredSubagentEnvelopeSession({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store,
    entry: opts?.entry,
  });
}

export function resolveStoredSubagentCapabilities(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
  },
) {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  const maxSpawnDepth =
    opts?.cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (!normalizedSessionKey) {
    return resolveSubagentCapabilities({ depth: 0, maxSpawnDepth });
  }
  if (!shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
    const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
      cfg: opts?.cfg,
      store: opts?.store,
    });
    return resolveSubagentCapabilities({ depth, maxSpawnDepth });
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  const entry = normalizedSessionKey
    ? resolveSessionCapabilityEntry({
        sessionKey: normalizedSessionKey,
        cfg: opts?.cfg,
        store,
      })
    : undefined;
  const depthStore = opts?.cfg && typeof entry?.spawnDepth !== "number" ? undefined : store;
  const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
    cfg: opts?.cfg,
    store: depthStore,
  });
  if (!isSubagentEnvelopeSession(normalizedSessionKey, { ...opts, store, entry })) {
    return resolveSubagentCapabilities({ depth, maxSpawnDepth });
  }
  const storedRole = normalizeSubagentRole(entry?.subagentRole);
  const storedControlScope = normalizeSubagentControlScope(entry?.subagentControlScope);
  const fallback = resolveSubagentCapabilities({ depth, maxSpawnDepth });
  const role = storedRole ?? fallback.role;
  const controlScope = storedControlScope ?? resolveSubagentControlScopeForRole(role);
  return {
    depth,
    role,
    controlScope,
    canSpawn: role === "main" || role === "orchestrator",
    canControlChildren: controlScope === "children",
  };
}

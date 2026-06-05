/**
 * Subagent capability resolution.
 * Combines session-key shape, stored envelopes, spawn depth, and inherited tool
 * policy to decide role, control scope, and subagent permissions.
 */
import {
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  isAcpSessionKey,
  isSubagentSessionKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import {
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "./inherited-tool-deny.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { normalizeSubagentSessionKey } from "./subagent-session-key.js";

/** Resolved role for a main session, orchestrating subagent, or leaf subagent. */
export type SubagentSessionRole = "main" | "orchestrator" | "leaf";
const SUBAGENT_SESSION_ROLES: readonly SubagentSessionRole[] = [
  "main",
  "orchestrator",
  "leaf",
] as const;

type SubagentControlScope = "children" | "none";
const SUBAGENT_CONTROL_SCOPES: readonly SubagentControlScope[] = ["children", "none"] as const;

type SessionCapabilityEntry = {
  sessionId?: unknown;
  spawnDepth?: unknown;
  subagentRole?: unknown;
  subagentControlScope?: unknown;
  spawnedBy?: unknown;
  inheritedToolAllow?: unknown;
  inheritedToolDeny?: unknown;
};

/** Minimal persisted session-store shape needed to resolve subagent capabilities. */
export type SessionCapabilityStore = Record<
  string,
  {
    sessionId?: unknown;
    spawnDepth?: unknown;
    subagentRole?: unknown;
    subagentControlScope?: unknown;
    spawnedBy?: unknown;
    inheritedToolAllow?: unknown;
    inheritedToolDeny?: unknown;
  }
>;

function normalizeSubagentRole(value: unknown): SubagentSessionRole | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_SESSION_ROLES.find((entry) => entry === trimmed);
}

function normalizeSubagentControlScope(value: unknown): SubagentControlScope | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_CONTROL_SCOPES.find((entry) => entry === trimmed);
}

function shouldInspectStoredSubagentEnvelope(sessionKey: string): boolean {
  // ACP session keys can represent resumed subagents only when their persisted
  // envelope carries subagent metadata or points back to a subagent parent.
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
    // Older callers may know the session id but not the exact store key, so
    // persisted entries are searchable by their normalized embedded sessionId.
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

/** Resolve the session-store subset used for subagent capability lookup. */
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

/** Resolve depth-derived role/scope booleans for a subagent position. */
function resolveSubagentRoleForDepth(params: {
  depth: number;
  maxSpawnDepth?: number;
}): SubagentSessionRole {
  const depth = resolveNonNegativeIntegerOption(params.depth, 0);
  const maxSpawnDepth = resolveIntegerOption(
    params.maxSpawnDepth,
    DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
    { min: 1 },
  );
  if (depth <= 0) {
    return "main";
  }
  return depth < maxSpawnDepth ? "orchestrator" : "leaf";
}

function resolveSubagentControlScopeForRole(role: SubagentSessionRole): SubagentControlScope {
  return role === "leaf" ? "none" : "children";
}

/** Resolve depth-derived role, scope, and spawn/control booleans. */
export function resolveSubagentCapabilities(params: { depth: number; maxSpawnDepth?: number }) {
  const depth = resolveNonNegativeIntegerOption(params.depth, 0);
  const role = resolveSubagentRoleForDepth(params);
  const controlScope = resolveSubagentControlScopeForRole(role);
  return {
    depth,
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
  // Follow parent links across stored ACP envelopes to recover subagent identity
  // for resumed sessions, while `visited` prevents malformed cycles.
  return isStoredSubagentEnvelopeSession(
    {
      sessionKey: spawnedBy,
      cfg: params.cfg,
      store: parentStore,
    },
    visited,
  );
}

/** Return true when a session key or persisted ACP envelope represents a subagent. */
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

/**
 * Resolve the effective subagent role/scope, combining stored envelope metadata
 * with depth-derived fallback behavior.
 */
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
  // If config is available but the envelope lacks an explicit spawnDepth, let
  // the depth helper read canonical persisted state instead of trusting a partial store.
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

/** Resolve inherited tool deny rules stored on a subagent envelope. */
export function resolveStoredSubagentInheritedToolDenylist(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
  },
): string[] {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  if (!normalizedSessionKey || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
    return [];
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  const entry = resolveSessionCapabilityEntry({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store,
  });
  return normalizeInheritedToolDenylist(entry?.inheritedToolDeny);
}

/** Resolve inherited tool allow rules stored on a subagent envelope. */
export function resolveStoredSubagentInheritedToolAllowlist(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
  },
): string[] {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  if (!normalizedSessionKey || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
    return [];
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  const entry = resolveSessionCapabilityEntry({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store,
  });
  return normalizeInheritedToolAllowlist(entry?.inheritedToolAllow);
}

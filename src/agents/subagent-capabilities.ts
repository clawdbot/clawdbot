/**
 * Subagent capability resolution.
 * Combines session-key shape, stored envelopes, spawn depth, and inherited tool
 * policy to decide role, control scope, and subagent permissions.
 */
import {
  resolveIntegerOption,
  resolveNonNegativeIntegerOption,
} from "@openclaw/normalization-core/number-coercion";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { resolveStorePath } from "../config/sessions.js";
import { listSessionEntriesReadOnly } from "../config/sessions/session-accessor.js";
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
  completionOwnerSessionKey?: unknown;
  inheritedToolPolicyVersion?: unknown;
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
    completionOwnerSessionKey?: unknown;
    inheritedToolPolicyVersion?: unknown;
    inheritedToolAllow?: unknown;
    inheritedToolDeny?: unknown;
  }
>;

type PersistedSubagentToolPolicyEnvelope = {
  sessionKey: string;
  spawnedBy: string;
  completionOwnerSessionKey?: string;
  inheritedToolAllow: string[];
  inheritedToolDeny: string[];
};

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

function readSessionStore(
  storePath: string,
  agentId: string,
): Record<string, SessionCapabilityEntry> {
  try {
    return Object.fromEntries(
      listSessionEntriesReadOnly({ agentId, storePath, clone: false }).map(
        ({ sessionKey, entry }) => [sessionKey, entry],
      ),
    );
  } catch {
    return {};
  }
}

function findEntryBySessionId(
  store: SessionCapabilityStore,
  sessionId: string,
): SessionCapabilityEntry | undefined {
  const normalizedSessionId = normalizeOptionalString(sessionId);
  if (!normalizedSessionId) {
    return undefined;
  }
  for (const entry of Object.values(store)) {
    // Older callers may know the session id but not the exact store key, so
    // persisted entries are searchable by their normalized embedded sessionId.
    const candidateSessionId = normalizeOptionalString(entry?.sessionId);
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
  const store = readSessionStore(storePath, parsed.agentId);
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
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
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
  return readSessionStore(storePath, parsed.agentId);
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
  const normalizedSessionKey = normalizeOptionalString(params.sessionKey);
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

  const spawnedBy = normalizeOptionalString(entry?.spawnedBy);
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
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
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
 * Resolve a persisted child envelope that is strong enough to carry authority.
 * Session-key shape alone is useful for fail-closed subagent restrictions, but
 * never sufficient to bypass requester-scoped policy re-resolution.
 */
export function resolvePersistedSubagentToolPolicyEnvelope(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: SessionCapabilityStore;
  },
): PersistedSubagentToolPolicyEnvelope | undefined {
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
  if (!normalizedSessionKey || !shouldInspectStoredSubagentEnvelope(normalizedSessionKey)) {
    return undefined;
  }
  const store = resolveSubagentCapabilityStore(normalizedSessionKey, opts);
  const entry = resolveSessionCapabilityEntry({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store,
  });
  const spawnedBy = normalizeOptionalString(entry?.spawnedBy);
  const hasSpawnDepth =
    typeof entry?.spawnDepth === "number" &&
    Number.isInteger(entry.spawnDepth) &&
    entry.spawnDepth >= 1;
  const role = normalizeSubagentRole(entry?.subagentRole);
  const controlScope = normalizeSubagentControlScope(entry?.subagentControlScope);
  if (
    !entry ||
    !spawnedBy ||
    entry.inheritedToolPolicyVersion !== 1 ||
    !isSubagentEnvelopeSession(normalizedSessionKey, { ...opts, store, entry }) ||
    (!hasSpawnDepth && role === undefined && controlScope === undefined)
  ) {
    return undefined;
  }
  const completionOwnerSessionKey = normalizeOptionalString(entry.completionOwnerSessionKey);
  return {
    sessionKey: normalizedSessionKey,
    spawnedBy,
    ...(completionOwnerSessionKey ? { completionOwnerSessionKey } : {}),
    inheritedToolAllow: normalizeInheritedToolAllowlist(entry.inheritedToolAllow),
    inheritedToolDeny: normalizeInheritedToolDenylist(entry.inheritedToolDeny),
  };
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
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
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
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
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
  const normalizedSessionKey = normalizeOptionalString(sessionKey);
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

import { DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH } from "../config/agent-limits.js";
import { loadSessionStore, resolveStorePath } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { getSubagentDepthFromSessionStore } from "./subagent-depth.js";
import { normalizeSubagentSessionKey } from "./subagent-session-key.js";

export const SUBAGENT_SESSION_ROLES = ["main", "orchestrator", "leaf"] as const;
export type SubagentSessionRole = (typeof SUBAGENT_SESSION_ROLES)[number];

export const SUBAGENT_CONTROL_SCOPES = ["children", "none"] as const;
export type SubagentControlScope = (typeof SUBAGENT_CONTROL_SCOPES)[number];

type SessionCapabilityEntry = {
  sessionId?: unknown;
  spawnDepth?: unknown;
  subagentRole?: unknown;
  subagentControlScope?: unknown;
};

function normalizeSubagentRole(value: unknown): SubagentSessionRole | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_SESSION_ROLES.find((entry) => entry === trimmed);
}

function normalizeSubagentControlScope(value: unknown): SubagentControlScope | undefined {
  const trimmed = normalizeOptionalLowercaseString(value);
  return SUBAGENT_CONTROL_SCOPES.find((entry) => entry === trimmed);
}

function readSessionStore(storePath: string): Record<string, SessionCapabilityEntry> {
  try {
    return loadSessionStore(storePath);
  } catch {
    return {};
  }
}

function findEntryBySessionId(
  store: Record<string, SessionCapabilityEntry>,
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
  store?: Record<string, SessionCapabilityEntry>;
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

export function resolveStoredSubagentCapabilities(
  sessionKey: string | undefined | null,
  opts?: {
    cfg?: OpenClawConfig;
    store?: Record<string, SessionCapabilityEntry>;
  },
) {
  const normalizedSessionKey = normalizeSubagentSessionKey(sessionKey);
  const maxSpawnDepth =
    opts?.cfg?.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  const depth = getSubagentDepthFromSessionStore(normalizedSessionKey, {
    cfg: opts?.cfg,
    store: opts?.store,
  });
  if (!normalizedSessionKey || !isSubagentSessionKey(normalizedSessionKey)) {
    return resolveSubagentCapabilities({ depth, maxSpawnDepth });
  }
  const entry = resolveSessionCapabilityEntry({
    sessionKey: normalizedSessionKey,
    cfg: opts?.cfg,
    store: opts?.store,
  });
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

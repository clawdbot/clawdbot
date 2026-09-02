import type { Result } from "@openclaw/normalization-core/result";
// Session visibility helpers decide which plugin sessions appear in user-facing lists.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../packages/normalization-core/src/string-coerce.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { callGateway as defaultCallGateway } from "../gateway/call.js";
import {
  createSessionVisibilityDecisionChecker,
  listSpawnedSessionKeysWithResult,
  logSessionOwnershipLookupFailure,
  renderSessionVisibilityDenial,
  resolveIncognitoSessionAccessDecision,
  sessionOwnershipLookupDenied,
  type SessionVisibilityDecisionAction,
  type SessionVisibilityDecisionMode,
  type SessionVisibilityDecisionPolicy,
  type SessionVisibilityDecisionRow,
  type SessionVisibilityDecision,
  type SessionOwnershipLookupFailure,
} from "./session-visibility-internal.js";

type GatewayCaller = typeof defaultCallGateway;

/** Configured visibility mode for session tools and session-related commands. */
export type SessionToolsVisibility = SessionVisibilityDecisionMode;

/** Agent-to-agent access policy compiled from `tools.agentToAgent` config. */
export type AgentToAgentPolicy = SessionVisibilityDecisionPolicy & {
  matchesAllow: (agentId: string) => boolean;
};

/** Session operation whose visibility error copy should be rendered. */
export type SessionAccessAction = SessionVisibilityDecisionAction;

/** Result of checking whether one session operation may target a session. */
export type SessionAccessResult =
  | { allowed: true; expectedSessionId?: string }
  | { allowed: false; error: string; status: "forbidden" };

type ScopedSessionAccessRequest = {
  action: Exclude<SessionAccessAction, "list">;
  requesterSessionKey: string;
  targetSessionKey: string;
};

type ScopedSessionAccessGrant = { expectedSessionId: string };

type ScopedSessionAccessProvider = (
  request: ScopedSessionAccessRequest,
) => ScopedSessionAccessGrant | undefined;

const scopedSessionAccessProviders = new Set<ScopedSessionAccessProvider>();

function registerScopedSessionAccessProvider(provider: ScopedSessionAccessProvider): () => void {
  scopedSessionAccessProviders.add(provider);
  return () => scopedSessionAccessProviders.delete(provider);
}

function resolveScopedSessionAccess(
  request: ScopedSessionAccessRequest,
): ScopedSessionAccessGrant | undefined {
  // Incognito transcripts must never be re-persisted through another session,
  // including host-scoped access paths that bypass normal visibility policy.
  if (resolveIncognitoSessionAccessDecision(request.targetSessionKey)) {
    return undefined;
  }
  for (const provider of scopedSessionAccessProviders) {
    try {
      const grant = provider(request);
      const expectedSessionId = normalizeOptionalString(grant?.expectedSessionId);
      if (expectedSessionId) {
        return { expectedSessionId };
      }
    } catch {
      // Access providers fail closed; normal visibility evaluation still runs.
    }
  }
  return undefined;
}

/** Minimal session row metadata needed to evaluate ownership and cross-agent access. */
export type SessionVisibilityRow = SessionVisibilityDecisionRow;

/** Public compatibility wrapper; direct guards use the richer private result. */
export async function listSpawnedSessionKeys(params: {
  requesterSessionKey: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<Set<string>> {
  const result = await listSpawnedSessionKeysWithResult(params);
  if (!result.ok) {
    logSessionOwnershipLookupFailure({
      requesterSessionKey: params.requesterSessionKey,
      failure: result.error,
    });
    return new Set();
  }
  return result.value;
}

/** Resolve configured session-tool visibility, defaulting invalid or missing values to agent. */
export function resolveSessionToolsVisibility(cfg: OpenClawConfig): SessionToolsVisibility {
  const raw = (cfg.tools as { sessions?: { visibility?: unknown } } | undefined)?.sessions
    ?.visibility;
  const value = normalizeLowercaseStringOrEmpty(raw);
  if (value === "self" || value === "tree" || value === "agent" || value === "all") {
    return value;
  }
  return "agent";
}

/** Resolve visibility after applying sandbox clamps for spawned-session-only agents. */
export function resolveEffectiveSessionToolsVisibility(params: {
  cfg: OpenClawConfig;
  sandboxed: boolean;
}): SessionToolsVisibility {
  const visibility = resolveSessionToolsVisibility(params.cfg);
  if (!params.sandboxed) {
    return visibility;
  }
  const sandboxClamp = params.cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
  if (sandboxClamp === "spawned" && visibility !== "tree") {
    return "tree";
  }
  return visibility;
}

/** Resolve sandbox-specific session visibility clamp for agent defaults. */
export function resolveSandboxSessionToolsVisibility(cfg: OpenClawConfig): "spawned" | "all" {
  return cfg.agents?.defaults?.sandbox?.sessionToolsVisibility ?? "spawned";
}

type CompiledAgentAllowPattern =
  | { kind: "all" }
  | { kind: "deny" }
  | { kind: "exact"; value: string }
  | {
      kind: "wildcard";
      first: string;
      last: string;
      interior: string[];
    };

function compileAgentAllowPattern(pattern: string): CompiledAgentAllowPattern {
  const raw = normalizeOptionalString(pattern) ?? "";
  if (!raw) {
    return { kind: "deny" };
  }
  if (raw === "*") {
    return { kind: "all" };
  }
  if (!raw.includes("*")) {
    return { kind: "exact", value: raw };
  }
  const parts = raw.toLowerCase().split("*");
  return {
    kind: "wildcard",
    first: parts[0] ?? "",
    last: parts[parts.length - 1] ?? "",
    interior: parts.slice(1, -1).filter(Boolean),
  };
}

/**
 * Linear-time case-insensitive glob matcher for precompiled `*` patterns.
 * Checks prefix, suffix, then ordered interior segments without entering the
 * regex engine, avoiding polynomial backtracking on repeated wildcards.
 */
function matchesCompiledWildcard(
  pattern: Extract<CompiledAgentAllowPattern, { kind: "wildcard" }>,
  lower: string,
): boolean {
  let pos = 0;
  if (pattern.first) {
    if (!lower.startsWith(pattern.first)) {
      return false;
    }
    pos = pattern.first.length;
  }

  const endBound = pattern.last ? lower.length - pattern.last.length : lower.length;
  if (pattern.last && (!lower.endsWith(pattern.last) || endBound < pos)) {
    return false;
  }

  for (const part of pattern.interior) {
    const idx = lower.indexOf(part, pos);
    if (idx === -1 || idx + part.length > endBound) {
      return false;
    }
    pos = idx + part.length;
  }

  return true;
}

/** Compile agent-to-agent allow rules into reusable matching predicates. */
export function createAgentToAgentPolicy(cfg: OpenClawConfig): AgentToAgentPolicy {
  const routingA2A = cfg.tools?.agentToAgent;
  const enabled = routingA2A?.enabled === true;
  const rawAllowPatterns = Array.isArray(routingA2A?.allow) ? routingA2A.allow : [];
  const allowPatterns = rawAllowPatterns.map((pattern) => compileAgentAllowPattern(pattern));
  const hasWildcardPatterns = allowPatterns.some((pattern) => pattern.kind === "wildcard");
  const matchesAllow = (agentId: string) => {
    if (allowPatterns.length === 0) {
      return true;
    }
    const lowerAgentId = hasWildcardPatterns ? agentId.toLowerCase() : "";
    return allowPatterns.some((pattern) => {
      if (pattern.kind === "all") {
        return true;
      }
      if (pattern.kind === "deny") {
        return false;
      }
      if (pattern.kind === "exact") {
        return pattern.value === agentId;
      }
      return matchesCompiledWildcard(pattern, lowerAgentId);
    });
  };
  const isAllowed = (requesterAgentId: string, targetAgentId: string) => {
    if (requesterAgentId === targetAgentId) {
      return true;
    }
    if (!enabled) {
      return false;
    }
    return matchesAllow(requesterAgentId) && matchesAllow(targetAgentId);
  };
  return { enabled, matchesAllow, isAllowed };
}

function toSessionAccessResult(
  decision: SessionVisibilityDecision,
  action: SessionAccessAction,
  targetSessionKey: string,
): SessionAccessResult {
  return decision.allowed
    ? decision
    : {
        allowed: false,
        status: "forbidden",
        error: renderSessionVisibilityDenial(decision, { action, targetSessionKey }),
      };
}

type SessionVisibilityCheckerParams = {
  action: SessionAccessAction;
  defaultAgentId?: string;
  requesterAgentId?: string;
  requesterSessionKey: string;
  mainSessionKey?: string;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
};

function createSessionVisibilityCheckerWithResult(
  params: SessionVisibilityCheckerParams & {
    spawnedKeys: Result<Set<string>, SessionOwnershipLookupFailure> | null;
  },
): { check: (targetSessionKey: string) => SessionAccessResult } {
  const spawnedKeys = params.spawnedKeys;
  let lookupFailureLogged = false;
  const decisionChecker = createSessionVisibilityDecisionChecker(params);

  const check = (targetSessionKey: string): SessionAccessResult => {
    const incognitoDenial = resolveIncognitoSessionAccessDecision(targetSessionKey);
    if (incognitoDenial) {
      return toSessionAccessResult(incognitoDenial, params.action, targetSessionKey);
    }
    if (params.action !== "list") {
      const scoped = resolveScopedSessionAccess({
        action: params.action,
        requesterSessionKey: params.requesterSessionKey,
        targetSessionKey,
      });
      if (scoped) {
        return { allowed: true, expectedSessionId: scoped.expectedSessionId };
      }
    }
    const spawnedKeySet = spawnedKeys?.ok ? spawnedKeys.value : undefined;
    const isSpawnedSession = spawnedKeySet?.has(targetSessionKey) === true;
    const result = decisionChecker.check({
      key: targetSessionKey,
      spawnedBy: isSpawnedSession ? params.requesterSessionKey : undefined,
    });
    if (!result.allowed) {
      const ownedResult = decisionChecker.check({
        key: targetSessionKey,
        spawnedBy: params.requesterSessionKey,
      });
      // Preserve denials that ownership cannot change; only ownership-dependent
      // denials should be replaced by lookup-failure guidance.
      const lookupFailed =
        spawnedKeys !== null &&
        !spawnedKeys.ok &&
        targetSessionKey !== params.requesterSessionKey &&
        targetSessionKey !== "current" &&
        ownedResult.allowed;
      if (lookupFailed) {
        if (!lookupFailureLogged) {
          lookupFailureLogged = true;
          logSessionOwnershipLookupFailure({
            requesterSessionKey: params.requesterSessionKey,
            failure: spawnedKeys.error,
          });
        }
        return toSessionAccessResult(
          sessionOwnershipLookupDenied(spawnedKeys.error.kind),
          params.action,
          targetSessionKey,
        );
      }
    }
    return toSessionAccessResult(result, params.action, targetSessionKey);
  };

  return { check };
}

/** Create a direct session-key visibility checker for one requester/action pair. */
function createSessionVisibilityCheckerImpl(
  params: SessionVisibilityCheckerParams & { spawnedKeys: Set<string> | null },
): { check: (targetSessionKey: string) => SessionAccessResult } {
  return createSessionVisibilityCheckerWithResult({
    ...params,
    spawnedKeys: params.spawnedKeys ? { ok: true, value: params.spawnedKeys } : null,
  });
}

/** Direct-key visibility checker plus registration for narrow host-owned grants. */
export const createSessionVisibilityChecker = Object.assign(createSessionVisibilityCheckerImpl, {
  registerScopedAccessProvider: registerScopedSessionAccessProvider,
  resolveScopedAccess: resolveScopedSessionAccess,
});

/** Create a row-aware visibility checker that can use owner/spawn metadata. */
export function createSessionVisibilityRowChecker(params: SessionVisibilityCheckerParams): {
  check: (row: SessionVisibilityRow) => SessionAccessResult;
} {
  const checker = createSessionVisibilityDecisionChecker(params);
  return {
    check: (row) => toSessionAccessResult(checker.check(row), params.action, row.key),
  };
}

/** Create a visibility guard, loading spawned-session ownership when direct keys need it. */
export async function createSessionVisibilityGuard(
  params: SessionVisibilityCheckerParams & { callGateway?: GatewayCaller },
): Promise<{
  check: (targetSessionKey: string) => SessionAccessResult;
}> {
  // Listing already has row ownership metadata; direct key actions still need
  // this lookup until every caller can pass a normalized session row.
  const spawnedKeys =
    params.action !== "list" && (params.visibility === "tree" || params.visibility === "all")
      ? await listSpawnedSessionKeysWithResult({
          requesterSessionKey: params.requesterSessionKey,
          callGateway: params.callGateway,
        })
      : null;
  return createSessionVisibilityCheckerWithResult({ ...params, spawnedKeys });
}

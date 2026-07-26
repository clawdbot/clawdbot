/**
 * Session visibility and access helpers for session tools.
 *
 * Adds OpenClaw session-key alias normalization and sandbox requester scoping over SDK visibility contracts.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { callGateway } from "../../gateway/call.js";
import {
  createSessionVisibilityChecker,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveSandboxSessionToolsVisibility,
  type AgentToAgentPolicy,
  type SessionAccessAction,
  type SessionAccessResult,
  type SessionToolsVisibility,
  type SessionVisibilityRow,
} from "../../plugin-sdk/session-visibility.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./sessions-resolution.js";

export {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";

type GatewayCaller = typeof callGateway;
type DescribedSessionVisibilityRow = SessionVisibilityRow & { sessionId?: string };

function readSessionVisibilityRow(value: unknown): DescribedSessionVisibilityRow | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const row = value as Record<string, unknown>;
  const key = normalizeOptionalString(row.key);
  if (!key) {
    return undefined;
  }
  return {
    key,
    sessionId: normalizeOptionalString(row.sessionId),
    agentId: normalizeOptionalString(row.agentId),
    ownerSessionKey: normalizeOptionalString(row.ownerSessionKey),
    spawnedBy: normalizeOptionalString(row.spawnedBy),
    parentSessionKey: normalizeOptionalString(row.parentSessionKey),
  };
}

/**
 * Authorize one exact session target from its durable Gateway row.
 * Older gateways or unavailable rows fall back to the existing fail-closed lookup.
 */
export async function resolveDirectSessionVisibility(params: {
  action: Exclude<SessionAccessAction, "list">;
  defaultAgentId?: string;
  requesterAgentId?: string;
  requesterSessionKey: string;
  targetSessionKey: string;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
  callGateway: GatewayCaller;
}): Promise<SessionAccessResult> {
  const scoped = createSessionVisibilityChecker.resolveScopedAccess({
    action: params.action,
    requesterSessionKey: params.requesterSessionKey,
    targetSessionKey: params.targetSessionKey,
  });
  if (scoped) {
    return { allowed: true, expectedSessionId: scoped.expectedSessionId };
  }

  const rowChecker = createSessionVisibilityRowChecker({
    action: params.action,
    defaultAgentId: params.defaultAgentId,
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    visibility: params.visibility,
    a2aPolicy: params.a2aPolicy,
  });
  if (
    params.targetSessionKey === params.requesterSessionKey ||
    params.targetSessionKey === "current"
  ) {
    return rowChecker.check({ key: params.targetSessionKey });
  }

  if (params.visibility === "tree" || params.visibility === "all") {
    try {
      const result = await params.callGateway<{ session?: unknown }>({
        method: "sessions.describe",
        params: { key: params.targetSessionKey },
      });
      const row = readSessionVisibilityRow(result?.session);
      if (row?.key === params.targetSessionKey) {
        const access = rowChecker.check(row);
        return access.allowed && row.sessionId
          ? { allowed: true, expectedSessionId: row.sessionId }
          : access;
      }
    } catch {
      // Preserve compatibility with older or temporarily unavailable gateways.
    }
  }

  const fallback = await createSessionVisibilityGuard({
    action: params.action,
    defaultAgentId: params.defaultAgentId,
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    visibility: params.visibility,
    a2aPolicy: params.a2aPolicy,
  });
  return fallback.check(params.targetSessionKey);
}

/** Resolves the requester context used to filter sandboxed session-tool access. */
export function resolveSandboxedSessionToolContext(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  sandboxed?: boolean;
}): {
  mainKey: string;
  alias: string;
  visibility: "spawned" | "all";
  requesterInternalKey: string | undefined;
  effectiveRequesterKey: string;
  restrictToSpawned: boolean;
} {
  const { mainKey, alias } = resolveMainSessionAlias(params.cfg);
  const visibility = resolveSandboxSessionToolsVisibility(params.cfg);
  const requesterSessionKey = normalizeOptionalString(params.agentSessionKey);
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : undefined;
  const effectiveRequesterKey = requesterInternalKey ?? alias;
  const restrictToSpawned =
    params.sandboxed === true &&
    visibility === "spawned" &&
    Boolean(requesterInternalKey) &&
    !isSubagentSessionKey(requesterInternalKey);
  // Main sessions can see all sessions; sandboxed non-subagent callers stay scoped to spawned rows.
  return {
    mainKey,
    alias,
    visibility,
    requesterInternalKey,
    effectiveRequesterKey,
    restrictToSpawned,
  };
}

/**
 * Session visibility and access helpers for session tools.
 *
 * Adds OpenClaw session-key alias normalization and sandbox requester scoping over SDK visibility contracts.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  logSessionOwnershipLookupFailure,
  lookupFailedDenialMessage,
} from "../../plugin-sdk/session-visibility-internal.js";
import {
  createSessionVisibilityChecker,
  createSessionVisibilityRowChecker,
  resolveSandboxSessionToolsVisibility,
  type AgentToAgentPolicy,
  type SessionAccessAction,
  type SessionAccessResult,
  type SessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";
import { isSubagentSessionKey } from "../../routing/session-key.js";
import type { AgentToolGatewayRequestCaller } from "./in-process-gateway.js";
import {
  lookupRequesterSessionOwnership,
  resolveInternalSessionKey,
  resolveMainSessionAlias,
} from "./sessions-resolution.js";

export {
  createAgentToAgentPolicy,
  createSessionVisibilityRowChecker,
  resolveEffectiveSessionToolsVisibility,
} from "../../plugin-sdk/session-visibility.js";

/** Check one prepared target without re-listing the requester's spawned sessions. */
export async function resolveSessionToolAccess(params: {
  action: SessionAccessAction;
  displayAction?: SessionAccessAction | "search";
  defaultAgentId?: string;
  requesterAgentId: string;
  requesterSessionKey: string;
  authorizationTargetSessionKey?: string;
  targetAgentId: string;
  targetSessionKey: string;
  requesterOwned: boolean;
  visibility: SessionToolsVisibility;
  a2aPolicy: AgentToAgentPolicy;
  callGateway?: AgentToolGatewayRequestCaller;
}): Promise<SessionAccessResult> {
  const authorizationTargetSessionKey =
    params.authorizationTargetSessionKey ?? params.targetSessionKey;
  if (params.action !== "list") {
    const scoped = createSessionVisibilityChecker.resolveScopedAccess({
      action: params.action,
      requesterSessionKey: params.requesterSessionKey,
      // A bare key is not globally unique under explicit ownership. Callers
      // qualify cross-agent targets so a grant cannot cross store owners.
      targetSessionKey: authorizationTargetSessionKey,
    });
    if (scoped) {
      return { allowed: true, expectedSessionId: scoped.expectedSessionId };
    }
  }
  const rowChecker = createSessionVisibilityRowChecker({
    action: params.action,
    defaultAgentId: params.targetAgentId ?? params.defaultAgentId,
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    visibility: params.visibility,
    a2aPolicy: params.a2aPolicy,
  });
  const check = (requesterOwned: boolean) =>
    rowChecker.check({
      key: authorizationTargetSessionKey,
      agentId: params.targetAgentId,
      ...(requesterOwned ? { spawnedBy: params.requesterSessionKey } : {}),
    });
  const initial = check(false);
  if (initial.allowed || params.action === "list") {
    return initial;
  }
  const requesterOwnedAccess = check(true);
  if (params.requesterOwned) {
    return requesterOwnedAccess;
  }
  // Ownership proof can only widen tree visibility; do not let an operational
  // lookup failure replace a deterministic self/A2A policy denial.
  if (!requesterOwnedAccess.allowed) {
    return initial;
  }
  const ownership = await lookupRequesterSessionOwnership({
    requesterSessionKey: params.requesterSessionKey,
    requesterAgentId: params.requesterAgentId,
    targetSessionKey: params.targetSessionKey,
    targetAgentId: params.targetAgentId,
    callGateway: params.callGateway,
  });
  if (!ownership.ok) {
    logSessionOwnershipLookupFailure({
      requesterSessionKey: params.requesterSessionKey,
      failure: ownership.error,
    });
    return {
      allowed: false,
      status: "forbidden",
      error: lookupFailedDenialMessage(params.displayAction ?? params.action, ownership.error.kind),
    };
  }
  return ownership.value ? requesterOwnedAccess : initial;
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

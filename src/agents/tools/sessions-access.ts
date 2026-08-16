/**
 * Session visibility and access helpers for session tools.
 *
 * Adds OpenClaw session-key alias normalization and sandbox requester scoping over SDK visibility contracts.
 */
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { resolveCanonicalMainSessionKey } from "../../config/sessions/main-session-key.js";
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
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
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
  action: Exclude<SessionAccessAction, "list">;
  displayAction?: SessionAccessAction | "search";
  requesterAgentId: string;
  requesterSessionKey: string;
  mainSessionKey?: string;
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
  const rowChecker = createSessionVisibilityRowChecker({
    action: params.action,
    defaultAgentId: params.targetAgentId,
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    mainSessionKey: params.mainSessionKey,
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
  if (initial.allowed) {
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
}) {
  const { mainKey, alias, scope } = resolveMainSessionAlias(params.cfg);
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
  const requesterAgentId = parseAgentSessionKey(requesterInternalKey)?.agentId;
  const mainSessionKey =
    !restrictToSpawned && requesterAgentId
      ? resolveCanonicalMainSessionKey({
          agentId: requesterAgentId,
          mainKey,
          sessionScope: scope,
        })
      : undefined;
  return {
    mainKey,
    alias,
    visibility,
    requesterInternalKey,
    mainSessionKey,
    effectiveRequesterKey,
    restrictToSpawned,
  };
}

/** Core-private spawned-session ownership lookup; not a published plugin SDK subpath. */
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeLowercaseStringOrEmpty } from "../../packages/normalization-core/src/string-coerce.js";
import { normalizeTrimmedStringList } from "../../packages/normalization-core/src/string-normalization.js";
import {
  GatewayCredentialsRequiredError,
  GatewayExplicitAuthRequiredError,
  isGatewayTransportError,
  callGateway as defaultCallGateway,
} from "../gateway/call.js";
import { GatewayClientRequestError } from "../gateway/client.js";
import { GatewaySecretRefUnavailableError } from "../gateway/credentials.js";
import { formatErrorMessage } from "../infra/errors.js";
import { logWarn } from "../logger.js";
import { redactIdentifier } from "../logging/redact-identifier.js";
import {
  isAcpSessionKey,
  isIncognitoSessionKey,
  isSubagentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../routing/session-key.js";

type GatewayCaller = typeof defaultCallGateway;

export type LookupFailureKind = "transient" | "credentials" | "unknown";

export type SessionVisibilityDecisionAction = "history" | "send" | "list" | "status";
export type SessionVisibilityDecisionPresentationAction =
  | SessionVisibilityDecisionAction
  | "search";
export type SessionVisibilityDecisionMode = "self" | "tree" | "agent" | "all";
export type SessionVisibilityDecisionPolicy = {
  enabled: boolean;
  isAllowed: (requesterAgentId: string, targetAgentId: string) => boolean;
};
export type SessionVisibilityDecisionRow = {
  key: string;
  agentId?: string;
  ownerSessionKey?: string;
  spawnedBy?: string;
  parentSessionKey?: string;
};
export type SessionVisibilityDenialReason =
  | "agent_to_agent_disabled"
  | "agent_to_agent_not_allowed"
  | "cross_agent_visibility_restricted"
  | "incognito_session"
  | "session_ownership_lookup_failed_credentials"
  | "session_ownership_lookup_failed_transient"
  | "session_ownership_lookup_failed_unknown"
  | "self_visibility_restricted"
  | "target_agent_ownership_unavailable"
  | "tree_visibility_restricted";
type SessionVisibilityDenied = {
  allowed: false;
  status: "forbidden";
  reasonCode: SessionVisibilityDenialReason;
  policyRefs: string[];
  contextFieldsUsed: string[];
  missingEvidence: string[];
};
export type SessionVisibilityDecision =
  | { allowed: true; expectedSessionId?: string }
  | SessionVisibilityDenied;

type SessionVisibilityDecisionParams = {
  action: SessionVisibilityDecisionAction;
  defaultAgentId?: string;
  requesterAgentId?: string;
  requesterSessionKey: string;
  mainSessionKey?: string;
  explicitTargetAgentOwnership?: boolean;
  visibility: SessionVisibilityDecisionMode;
  a2aPolicy: SessionVisibilityDecisionPolicy;
};

function denied(
  reasonCode: SessionVisibilityDenialReason,
  policyRefs: string[],
  contextFieldsUsed: string[],
  missingEvidence: string[] = [],
): SessionVisibilityDenied {
  return {
    allowed: false,
    status: "forbidden",
    reasonCode,
    policyRefs,
    contextFieldsUsed,
    missingEvidence,
  };
}

export function resolveIncognitoSessionAccessDecision(
  targetSessionKey: string,
): SessionVisibilityDecision | undefined {
  return isIncognitoSessionKey(targetSessionKey)
    ? denied("incognito_session", ["sessions.incognito"], ["targetSessionKey"])
    : undefined;
}

function rowOwnedByRequester(
  row: SessionVisibilityDecisionRow,
  requesterSessionKey: string,
): boolean {
  return (
    row.ownerSessionKey === requesterSessionKey ||
    row.spawnedBy === requesterSessionKey ||
    row.parentSessionKey === requesterSessionKey
  );
}

/** Core-private policy owner; public SDK wrappers only render this decision. */
export function createSessionVisibilityDecisionChecker(params: SessionVisibilityDecisionParams): {
  check: (row: SessionVisibilityDecisionRow) => SessionVisibilityDecision;
} {
  const requesterAgentId =
    normalizeLowercaseStringOrEmpty(params.requesterAgentId) ||
    resolveAgentIdFromSessionKey(params.requesterSessionKey, params.defaultAgentId);
  return {
    check: (row) => {
      const targetSessionKey = row.key;
      const incognito = resolveIncognitoSessionAccessDecision(targetSessionKey);
      if (incognito) {
        return incognito;
      }
      const isRequesterSession =
        targetSessionKey === params.requesterSessionKey || targetSessionKey === "current";
      let targetAgentId = normalizeLowercaseStringOrEmpty(row.agentId);
      if (
        !targetAgentId &&
        (targetSessionKey === "current" ||
          (targetSessionKey === params.requesterSessionKey && !params.defaultAgentId?.trim()))
      ) {
        targetAgentId = requesterAgentId;
      }
      if (!targetAgentId) {
        try {
          targetAgentId = resolveAgentIdFromSessionKey(targetSessionKey, params.defaultAgentId);
        } catch {
          return denied(
            "target_agent_ownership_unavailable",
            ["session.owner"],
            ["requesterSessionKey", "targetSessionKey"],
            ["session.owner"],
          );
        }
      }
      const isRequesterOwned =
        rowOwnedByRequester(row, params.requesterSessionKey) ||
        (params.visibility === "tree" &&
          targetAgentId === requesterAgentId &&
          params.requesterSessionKey === params.mainSessionKey);
      const isCrossAgent = targetAgentId !== requesterAgentId;
      // Native child lineage can authorize a cross-agent backend without
      // weakening ordinary cross-agent session policy.
      if (
        !isRequesterSession &&
        isRequesterOwned &&
        (!isCrossAgent ||
          isAcpSessionKey(targetSessionKey) ||
          isSubagentSessionKey(targetSessionKey)) &&
        (params.visibility === "tree" || params.visibility === "all")
      ) {
        return { allowed: true };
      }
      if (isCrossAgent) {
        const a2aDenial = !params.a2aPolicy.enabled
          ? denied(
              "agent_to_agent_disabled",
              ["tools.agentToAgent.enabled"],
              ["requesterAgentId", "targetAgentId"],
            )
          : !params.a2aPolicy.isAllowed(requesterAgentId, targetAgentId)
            ? denied(
                "agent_to_agent_not_allowed",
                ["tools.agentToAgent.allow"],
                ["requesterAgentId", "targetAgentId"],
              )
            : undefined;
        // Status historically reports the explicit fixed-store owner's A2A
        // gate before generic visibility; retain that operator contract here.
        if (params.action === "status" && params.explicitTargetAgentOwnership && a2aDenial) {
          return a2aDenial;
        }
        if (params.visibility !== "all") {
          return denied(
            "cross_agent_visibility_restricted",
            ["tools.sessions.visibility"],
            ["requesterAgentId", "targetAgentId", "visibility"],
          );
        }
        if (a2aDenial) {
          return a2aDenial;
        }
        return { allowed: true };
      }
      if (params.visibility === "self" && !isRequesterSession) {
        return denied(
          "self_visibility_restricted",
          ["tools.sessions.visibility"],
          ["requesterSessionKey", "targetSessionKey", "visibility"],
        );
      }
      if (params.visibility === "tree" && !isRequesterSession && !isRequesterOwned) {
        return denied(
          "tree_visibility_restricted",
          ["tools.sessions.visibility"],
          ["requesterSessionKey", "targetSessionKey", "requesterOwned", "visibility"],
        );
      }
      return { allowed: true };
    },
  };
}

export function sessionOwnershipLookupDenied(kind: LookupFailureKind): SessionVisibilityDenied {
  return denied(
    `session_ownership_lookup_failed_${kind}`,
    ["tools.sessions.visibility"],
    ["requesterSessionKey", "targetSessionKey"],
    ["session.owner"],
  );
}

function actionPrefix(action: SessionVisibilityDecisionPresentationAction): string {
  return action === "list" ? "Session list" : `Session ${action}`;
}

/** Preserve the established public/tool prose without making prose the policy fact. */
export function renderSessionVisibilityDenial(
  denial: Extract<SessionVisibilityDecision, { allowed: false }>,
  params: {
    action: SessionVisibilityDecisionPresentationAction;
    targetSessionKey?: string;
  },
): string {
  switch (denial.reasonCode) {
    case "incognito_session":
      return `Session not visible from session tools${params.targetSessionKey ? `: ${params.targetSessionKey}` : ""}`;
    case "target_agent_ownership_unavailable":
      return `${actionPrefix(params.action)} denied because target agent ownership is unavailable.`;
    case "cross_agent_visibility_restricted":
      return `${actionPrefix(params.action)} visibility is restricted. Set tools.sessions.visibility=all and tools.agentToAgent.enabled=true to allow cross-agent access; use tools.agentToAgent.allow to restrict permitted agent pairs.`;
    case "agent_to_agent_disabled":
      if (params.action === "send") {
        return "Agent-to-agent messaging is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent sends.";
      }
      if (params.action === "list") {
        return "Agent-to-agent listing is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent visibility.";
      }
      return `Agent-to-agent ${params.action} is disabled. Set tools.agentToAgent.enabled=true to allow cross-agent access.`;
    case "agent_to_agent_not_allowed":
      return `Agent-to-agent ${params.action === "send" ? "messaging" : params.action === "list" ? "listing" : params.action} denied by tools.agentToAgent.allow.`;
    case "self_visibility_restricted":
      return `${actionPrefix(params.action)} visibility is restricted to the current session (tools.sessions.visibility=self).`;
    case "tree_visibility_restricted":
      return `${actionPrefix(params.action)} visibility is restricted to the current session tree (tools.sessions.visibility=tree).`;
    case "session_ownership_lookup_failed_transient":
      return lookupFailedDenialMessage(params.action, "transient");
    case "session_ownership_lookup_failed_credentials":
      return lookupFailedDenialMessage(params.action, "credentials");
    case "session_ownership_lookup_failed_unknown":
      return lookupFailedDenialMessage(params.action, "unknown");
    default:
      throw new Error("unsupported session visibility denial");
  }
}

export function classifyLookupFailure(error: unknown): LookupFailureKind {
  if (error instanceof GatewayClientRequestError && error.retryable) {
    return "transient";
  }
  if (
    isGatewayTransportError(error) &&
    (error.kind === "timeout" || error.code === 1006 || error.code === 1013)
  ) {
    return "transient";
  }
  if (
    error instanceof GatewayCredentialsRequiredError ||
    error instanceof GatewayExplicitAuthRequiredError ||
    error instanceof GatewaySecretRefUnavailableError
  ) {
    return "credentials";
  }
  return "unknown";
}

export function lookupFailedDenialSuffix(kind: LookupFailureKind): string {
  if (kind === "transient") {
    return "spawned-session ownership lookup failed (transient); retry once, then ask the operator to inspect OpenClaw logs.";
  }
  if (kind === "credentials") {
    return "spawned-session ownership lookup failed; ask the operator to check gateway configuration and credentials.";
  }
  return "spawned-session ownership lookup failed; ask the operator to inspect OpenClaw logs.";
}

export function lookupFailedDenialMessage(
  action: "history" | "send" | "status" | "list" | "search",
  kind: LookupFailureKind,
): string {
  const label = action === "list" ? "Session list" : `Session ${action}`;
  return `${label} denied because ${lookupFailedDenialSuffix(kind)}`;
}

export function lookupFailedOperationMessage(
  action: "history" | "send" | "status" | "list" | "search",
  kind: LookupFailureKind,
): string {
  const label = action === "list" ? "Session list" : `Session ${action}`;
  const guidance =
    kind === "transient"
      ? "retry once, then ask the operator to inspect OpenClaw logs"
      : kind === "credentials"
        ? "ask the operator to check gateway configuration and credentials"
        : "ask the operator to inspect OpenClaw logs";
  return `${label} failed because session lookup failed${kind === "transient" ? " (transient)" : ""}; ${guidance}.`;
}

export type SessionOwnershipLookupFailure = {
  kind: LookupFailureKind;
  diagnostic: string;
};

export function sessionOwnershipLookupFailure(error: unknown): SessionOwnershipLookupFailure {
  return {
    kind: classifyLookupFailure(error),
    diagnostic: formatErrorMessage(error),
  };
}

export function logSessionOwnershipLookupFailure(params: {
  requesterSessionKey: string;
  failure: SessionOwnershipLookupFailure;
}): void {
  logWarn(
    `session-visibility: spawned-session ownership lookup failed for requester=${redactIdentifier(params.requesterSessionKey)}: ${params.failure.diagnostic}`,
  );
}

/** List sessions spawned by the requester through the gateway session list method. */
export async function listSpawnedSessionKeysWithResult(params: {
  requesterSessionKey: string;
  limit?: number;
  callGateway?: GatewayCaller;
}): Promise<Result<Set<string>, SessionOwnershipLookupFailure>> {
  const limit =
    typeof params.limit === "number" && Number.isFinite(params.limit)
      ? Math.max(1, Math.floor(params.limit))
      : undefined;
  try {
    const list = await (params.callGateway ?? defaultCallGateway)<{
      sessions: Array<{ key?: unknown }>;
    }>({
      method: "sessions.list",
      params: {
        includeGlobal: false,
        includeUnknown: false,
        ...(limit !== undefined ? { limit } : {}),
        spawnedBy: params.requesterSessionKey,
      },
    });
    if (!Array.isArray(list?.sessions)) {
      return err({
        kind: "unknown",
        diagnostic: "gateway sessions.list returned an invalid response",
      });
    }
    const sessions = list.sessions;
    const keys = normalizeTrimmedStringList(sessions.map((entry) => entry?.key));
    return ok(new Set(keys));
  } catch (error) {
    return err(sessionOwnershipLookupFailure(error));
  }
}

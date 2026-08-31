/**
 * Session visibility and access helpers for session tools.
 *
 * Adds OpenClaw session-key alias normalization and sandbox requester scoping over SDK visibility contracts.
 */
import { randomUUID } from "node:crypto";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { recordExecutionDecisionWork } from "../../audit/execution-decision-work.js";
import { SESSION_LIFECYCLE_CHANGED_ERROR_REASON } from "../../config/sessions/lifecycle.js";
import { resolveCanonicalMainSessionKey } from "../../config/sessions/main-session-key.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isGatewayClientRequestError } from "../../gateway/call.js";
import {
  createSessionVisibilityDecisionChecker,
  logSessionOwnershipLookupFailure,
  renderSessionVisibilityDenial,
  sessionOwnershipLookupDenied,
  type SessionVisibilityDecision,
  type SessionVisibilityDecisionPresentationAction,
} from "../../plugin-sdk/session-visibility-internal.js";
import {
  createSessionVisibilityChecker,
  resolveSandboxSessionToolsVisibility,
  type AgentToAgentPolicy,
  type SessionAccessAction,
  type SessionToolsVisibility,
  type SessionVisibilityRow,
} from "../../plugin-sdk/session-visibility.js";
import { isSubagentSessionKey, parseAgentSessionKey } from "../../routing/session-key.js";
import { resolveSessionAgentId } from "../agent-scope.js";
import { getGatewayToolCallerIdentity } from "./gateway-caller-context.js";
import {
  callAgentToolGatewayRequest,
  type AgentToolGatewayRequestCaller,
} from "./in-process-gateway.js";
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

type SessionToolAccessDenied = Extract<SessionVisibilityDecision, { allowed: false }>;
export type SessionToolAccessResult = SessionVisibilityDecision;
export type SessionToolActionOperation =
  | "archive"
  | "create"
  | "delete"
  | "fork"
  | "patch"
  | "reset"
  | "restore"
  | "send";
export type SessionToolActionFact = "committed" | "conflict" | "no-op" | "scheduled";

type DescribedSessionVisibilityRow = SessionVisibilityRow & { sessionId?: string };

function readDescribedSessionVisibilityRow(value: unknown): DescribedSessionVisibilityRow | null {
  if (!isRecord(value)) {
    return null;
  }
  const key = normalizeOptionalString(value.key);
  if (!key) {
    return null;
  }
  return {
    key,
    agentId: normalizeOptionalString(value.agentId),
    ownerSessionKey: normalizeOptionalString(value.ownerSessionKey),
    spawnedBy: normalizeOptionalString(value.spawnedBy),
    parentSessionKey: normalizeOptionalString(value.parentSessionKey),
    sessionId: normalizeOptionalString(value.sessionId),
  };
}

/** Render operator guidance only when a tool presents a private access decision. */
export const formatSessionToolAccessDenial = renderSessionVisibilityDenial;

function recordAdmittedSessionDecision(params: {
  action: SessionVisibilityDecisionPresentationAction | SessionToolActionOperation;
  targetAgentId: string;
  targetSessionKey: string;
  outcome: "allowed" | "denied" | "not-applicable";
  reasonCode: string;
  coverageState: "attribution-only" | "enforced" | "unknown";
  policyRefs?: string[];
  contextFieldsUsed: string[];
  missingEvidence?: string[];
  owner: "session-access" | "session-action";
  decisionBoundary: "session-tool.access" | "session-tool.result";
}): boolean {
  const caller = getGatewayToolCallerIdentity();
  if (!caller?.executionIdentityToken || !caller.receiptAuthority) {
    return false;
  }
  try {
    if (caller.receiptAuthority() === false) {
      return false;
    }
  } catch {
    return false;
  }
  const receiptId = `${params.owner}:${randomUUID()}`;
  return recordExecutionDecisionWork({
    workVersion: 1,
    token: caller.executionIdentityToken,
    receipt: {
      schemaVersion: 1,
      receiptId,
      occurredAt: Date.now(),
      action: { family: "session", operation: params.action },
      decision: { outcome: params.outcome, reasonCode: params.reasonCode },
      enforcement: {
        coverageState: params.coverageState,
        policyRefs: params.policyRefs ?? [],
        grantRefs: [],
        contextFieldsUsed: params.contextFieldsUsed,
      },
      source: {
        owner: params.owner,
        recordRef: receiptId,
        decisionBoundary: params.decisionBoundary,
      },
      missingEvidence: params.missingEvidence ?? [],
      remediation: [],
    },
    refs: {
      target: {
        namespace: "session",
        value: JSON.stringify([params.targetAgentId, params.targetSessionKey]),
      },
    },
  });
}

function recordAdmittedSessionAccessDenial(params: {
  action: SessionVisibilityDecisionPresentationAction;
  targetAgentId: string;
  targetSessionKey: string;
  denial: SessionToolAccessDenied;
}): boolean {
  return recordAdmittedSessionDecision({
    action: params.action,
    targetAgentId: params.targetAgentId,
    targetSessionKey: params.targetSessionKey,
    outcome: "denied",
    reasonCode: params.denial.reasonCode,
    coverageState: params.denial.missingEvidence.length > 0 ? "unknown" : "enforced",
    policyRefs: params.denial.policyRefs,
    contextFieldsUsed: params.denial.contextFieldsUsed,
    missingEvidence: params.denial.missingEvidence,
    owner: "session-access",
    decisionBoundary: "session-tool.access",
  });
}

/** Queue an owner-native model-mediated session result after its final await. */
export function recordSessionToolActionFact(params: {
  operation: SessionToolActionOperation;
  fact: SessionToolActionFact;
  targetAgentId: string;
  targetSessionKey: string;
}): boolean {
  const reasonCode = `session_${params.operation.replaceAll("-", "_")}_${params.fact.replaceAll("-", "_")}`;
  return recordAdmittedSessionDecision({
    action: params.operation,
    targetAgentId: params.targetAgentId,
    targetSessionKey: params.targetSessionKey,
    outcome:
      params.fact === "conflict"
        ? "denied"
        : params.fact === "no-op"
          ? "not-applicable"
          : "allowed",
    reasonCode,
    coverageState: "attribution-only",
    contextFieldsUsed: ["targetAgentId", "sessionActionResult"],
    owner: "session-action",
    decisionBoundary: "session-tool.result",
  });
}

/** Record owner-native lifecycle conflicts without classifying presentation text. */
export async function runSessionToolActionWithConflictReceipt<T>(params: {
  operation: "archive" | "delete" | "patch" | "reset" | "restore";
  targetAgentId: string;
  targetSessionKey: string;
  run: () => Promise<T>;
}): Promise<T> {
  try {
    return await params.run();
  } catch (error) {
    if (
      isGatewayClientRequestError(error) &&
      isRecord(error.details) &&
      error.details.reason === SESSION_LIFECYCLE_CHANGED_ERROR_REASON
    ) {
      recordSessionToolActionFact({
        operation: params.operation,
        fact: "conflict",
        targetAgentId: params.targetAgentId,
        targetSessionKey: params.targetSessionKey,
      });
    }
    throw error;
  }
}

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
}): Promise<SessionToolAccessResult> {
  const authorizationTargetSessionKey =
    params.authorizationTargetSessionKey ?? params.targetSessionKey;
  const deny = (denial: SessionToolAccessDenied) => {
    recordAdmittedSessionAccessDenial({
      action: params.displayAction ?? params.action,
      targetAgentId: params.targetAgentId,
      targetSessionKey: authorizationTargetSessionKey,
      denial,
    });
    return denial;
  };
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
  const decisionChecker = createSessionVisibilityDecisionChecker({
    action: params.action,
    defaultAgentId: params.targetAgentId,
    requesterAgentId: params.requesterAgentId,
    requesterSessionKey: params.requesterSessionKey,
    mainSessionKey: params.mainSessionKey,
    explicitTargetAgentOwnership: !parseAgentSessionKey(authorizationTargetSessionKey),
    visibility: params.visibility,
    a2aPolicy: params.a2aPolicy,
  });
  const check = (requesterOwned: boolean) =>
    decisionChecker.check({
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
    if (requesterOwnedAccess.allowed) {
      return requesterOwnedAccess;
    }
    return deny(requesterOwnedAccess);
  }
  // Ownership proof can only widen tree visibility; do not let an operational
  // lookup failure replace a deterministic self/A2A policy denial.
  if (!requesterOwnedAccess.allowed) {
    return deny(initial);
  }
  if (
    params.action === "history" &&
    params.displayAction !== "search" &&
    authorizationTargetSessionKey === params.targetSessionKey
  ) {
    try {
      const described = await (params.callGateway ?? callAgentToolGatewayRequest)<{
        session?: unknown;
      }>({
        method: "sessions.describe",
        params: { key: params.targetSessionKey },
      });
      const row = readDescribedSessionVisibilityRow(described?.session);
      if (row?.key === params.targetSessionKey) {
        const access = decisionChecker.check(row);
        if (!access.allowed) {
          return deny(access);
        }
        if (row.sessionId) {
          return { allowed: true, expectedSessionId: row.sessionId };
        }
      }
    } catch {
      // Older or temporarily unavailable gateways keep the existing fail-closed lookup below.
    }
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
    return deny(sessionOwnershipLookupDenied(ownership.error.kind));
  }
  if (ownership.value) {
    return requesterOwnedAccess;
  }
  return deny(initial);
}

/** Resolves the requester context used to filter sandboxed session-tool access. */
export function resolveSandboxedSessionToolContext(params: {
  cfg: OpenClawConfig;
  agentSessionKey?: string;
  requesterAgentId?: string;
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
  const requesterAgentId =
    parseAgentSessionKey(requesterInternalKey)?.agentId ??
    (!restrictToSpawned && requesterInternalKey === alias
      ? resolveSessionAgentId({
          config: params.cfg,
          sessionKey: requesterInternalKey,
          agentId: params.requesterAgentId,
        })
      : undefined);
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

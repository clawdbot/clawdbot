import { isValidAgentId, normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";

type SessionStewardBoundaryKind = "agent" | "global" | "unscoped" | "unknown" | "malformed";

export type SessionStewardAgentRelation = "same_agent" | "cross_agent" | "unbound";

export type SessionStewardBoundaryDecision = {
  kind: SessionStewardBoundaryKind;
  ownerAgentId: string;
  requestedAgentId: string;
  agentRelation: SessionStewardAgentRelation;
  affectedSession: string;
};

type ResolveSessionStewardBoundaryParams = {
  sessionKey?: string | null;
  requestedAgentId?: string | null;
  configuredAgentIds?: readonly string[];
};

const UNKNOWN = "UNKNOWN";
const UNKNOWN_AGENT_SESSION = "agent:UNKNOWN:REDACTED";
const CREDENTIAL_LIKE_AGENT_ID_RE = /^(?:sk|pk)-[a-z0-9][a-z0-9._-]{8,}$/iu;
const CREDENTIAL_LIKE_TOKEN_ID_RE = /^(?:xox[baprs]-|gh[pousr]_|glpat-)[a-z0-9_-]{8,}$/iu;

type ResolvedBoundaryAgentId = {
  comparisonId: string;
  exposedId: string;
};

function isCredentialLikeAgentId(value: string): boolean {
  return CREDENTIAL_LIKE_AGENT_ID_RE.test(value) || CREDENTIAL_LIKE_TOKEN_ID_RE.test(value);
}

function normalizeBoundarySegment(value: string | null | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function normalizeBoundaryAgentId(
  value: string | null | undefined,
  configuredAgentIds: readonly string[] | undefined,
): ResolvedBoundaryAgentId {
  const normalized = normalizeBoundarySegment(value);
  if (!normalized) {
    return { comparisonId: "", exposedId: "" };
  }
  const configured = configuredAgentIds?.find(
    (agentId) => normalizeBoundarySegment(agentId) === normalized,
  );
  if (configured) {
    const configuredId = normalizeAgentId(configured);
    if (isValidAgentId(configuredId)) {
      return {
        comparisonId: configuredId,
        exposedId: isCredentialLikeAgentId(configuredId) ? UNKNOWN : configuredId,
      };
    }
  }
  if (!isValidAgentId(normalized)) {
    return { comparisonId: "", exposedId: "" };
  }
  // Wire-controlled agent ids remain comparison-only until config confirms
  // that they are trusted routing identities; diagnostics expose UNKNOWN.
  return {
    comparisonId: normalized,
    exposedId: UNKNOWN,
  };
}

function unknownDecision(requestedAgentId: string): SessionStewardBoundaryDecision {
  return {
    kind: "unknown",
    ownerAgentId: UNKNOWN,
    requestedAgentId,
    agentRelation: "unbound",
    affectedSession: UNKNOWN,
  };
}

function malformedDecision(requestedAgentId: string): SessionStewardBoundaryDecision {
  return {
    kind: "malformed",
    ownerAgentId: UNKNOWN,
    requestedAgentId,
    agentRelation: "unbound",
    affectedSession: UNKNOWN,
  };
}

function resolveAgentRelation(
  ownerAgentId: string,
  requestedAgentId: string,
): SessionStewardAgentRelation {
  if (!ownerAgentId || !requestedAgentId) {
    return "unbound";
  }
  return ownerAgentId === requestedAgentId ? "same_agent" : "cross_agent";
}

// Session Steward policy returns only normalized owners and redacted selectors.
// Raw session tails remain outside this decision object to keep boundary logs safe.
export function resolveSessionStewardBoundary(
  params: ResolveSessionStewardBoundaryParams,
): SessionStewardBoundaryDecision {
  const rawRequestedAgentId = normalizeBoundarySegment(params.requestedAgentId);
  const requestedAgent = normalizeBoundaryAgentId(
    params.requestedAgentId,
    params.configuredAgentIds,
  );
  if (rawRequestedAgentId && !requestedAgent.comparisonId) {
    return malformedDecision(UNKNOWN);
  }
  const requestedAgentId = requestedAgent.exposedId || UNKNOWN;
  const normalizedSessionKey = normalizeBoundarySegment(params.sessionKey);
  if (!normalizedSessionKey) {
    return unknownDecision(requestedAgentId);
  }
  if (normalizedSessionKey === "global") {
    return {
      kind: "global",
      ownerAgentId: UNKNOWN,
      requestedAgentId,
      agentRelation: "unbound",
      affectedSession: "GLOBAL",
    };
  }

  const parts = normalizedSessionKey.split(":");
  if (parts[0] !== "agent") {
    return {
      kind: "unscoped",
      ownerAgentId: UNKNOWN,
      requestedAgentId,
      agentRelation: "unbound",
      affectedSession: "UNSCOPED",
    };
  }

  if (!parseAgentSessionKey(normalizedSessionKey)) {
    return malformedDecision(requestedAgentId);
  }

  const rawOwnerAgentId = parts[1]?.trim() ?? "";
  const ownerAgent = normalizeBoundaryAgentId(rawOwnerAgentId, params.configuredAgentIds);
  const hasMalformedEmptyTail =
    parts.length > 2 && !parts.slice(2).some((part) => part.trim().length > 0);
  if (!rawOwnerAgentId || !ownerAgent.comparisonId || hasMalformedEmptyTail) {
    return malformedDecision(requestedAgentId);
  }

  return {
    kind: "agent",
    ownerAgentId: ownerAgent.exposedId,
    requestedAgentId,
    agentRelation: resolveAgentRelation(ownerAgent.comparisonId, requestedAgent.comparisonId),
    affectedSession:
      ownerAgent.exposedId === UNKNOWN
        ? UNKNOWN_AGENT_SESSION
        : `agent:${ownerAgent.exposedId}:REDACTED`,
  };
}

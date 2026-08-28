// Gateway wrappers keep Session Steward policy errors redacted and protocol-shaped.
import { ErrorCodes, errorShape } from "../../packages/gateway-protocol/src/index.js";
import { listAgentIds } from "../agents/agent-scope-config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { emitTrustedDiagnosticEvent } from "../infra/diagnostic-events.js";
import {
  resolveSessionStewardBoundary,
  type SessionStewardAgentRelation,
  type SessionStewardBoundaryDecision,
} from "../sessions/session-steward-policy.js";

type GatewaySessionStewardBoundaryTelemetry = {
  surface: string;
  action?: string;
};

type GatewaySessionStewardBoundaryParams = {
  sessionKey?: string | null;
  requestedAgentId?: string | null;
  config?: OpenClawConfig;
} & GatewaySessionStewardBoundaryTelemetry;

type GatewaySessionStewardBoundaryFacts = {
  affectedSession: string;
  ownerAgentId: string;
  requestedAgentId: string;
  agentRelation: SessionStewardAgentRelation;
};

type GatewaySessionStewardBoundaryCheck =
  | {
      ok: true;
      boundary: GatewaySessionStewardBoundaryFacts;
      decision: SessionStewardBoundaryDecision;
    }
  | {
      ok: false;
      boundary: GatewaySessionStewardBoundaryFacts;
      decision: SessionStewardBoundaryDecision;
      error: ReturnType<typeof errorShape>;
    };

function toGatewaySessionStewardBoundaryFacts(
  decision: SessionStewardBoundaryDecision,
): GatewaySessionStewardBoundaryFacts {
  return {
    affectedSession: decision.affectedSession,
    ownerAgentId: decision.ownerAgentId,
    requestedAgentId: decision.requestedAgentId,
    agentRelation: decision.agentRelation,
  };
}

function sessionBoundaryErrorMessage(decision: SessionStewardBoundaryDecision): string {
  if (decision.kind === "malformed") {
    return "malformed session boundary";
  }
  if (decision.agentRelation === "cross_agent") {
    if (decision.ownerAgentId === "UNKNOWN" || decision.requestedAgentId === "UNKNOWN") {
      return "cross-agent session boundary";
    }
    return `agent "${decision.requestedAgentId}" does not match session key agent "${decision.ownerAgentId}"`;
  }
  return "session key agent does not match agentId";
}

function emitSessionStewardBoundaryDecision(params: {
  telemetry: GatewaySessionStewardBoundaryTelemetry;
  decision: SessionStewardBoundaryDecision;
  outcome: "allow" | "reject";
  reason?: string;
  eventType: "session_steward.boundary_decision" | "session_steward.boundary_rejected";
}): void {
  const base = {
    surface: params.telemetry.surface,
    ...(params.telemetry.action ? { action: params.telemetry.action } : {}),
    boundaryKind: params.decision.kind,
    agentRelation: params.decision.agentRelation,
    affectedSession: params.decision.affectedSession,
    ownerAgentId: params.decision.ownerAgentId,
    requestedAgentId: params.decision.requestedAgentId,
    ...(params.reason ? { reason: params.reason } : {}),
  };
  if (params.eventType === "session_steward.boundary_rejected") {
    emitTrustedDiagnosticEvent({
      type: "session_steward.boundary_rejected",
      ...base,
      outcome: "reject",
    });
    return;
  }
  emitTrustedDiagnosticEvent({
    type: "session_steward.boundary_decision",
    ...base,
    outcome: params.outcome,
  });
}

function resolveGatewaySessionStewardBoundary(params: GatewaySessionStewardBoundaryParams): {
  boundary: GatewaySessionStewardBoundaryFacts;
  decision: SessionStewardBoundaryDecision;
} {
  const configuredAgentIds = params.config ? listAgentIds(params.config) : undefined;
  const decision = resolveSessionStewardBoundary({
    sessionKey: params.sessionKey,
    requestedAgentId: params.requestedAgentId,
    ...(configuredAgentIds?.length ? { configuredAgentIds } : {}),
  });
  const invalid = decision.kind === "malformed" || decision.agentRelation === "cross_agent";
  emitSessionStewardBoundaryDecision({
    telemetry: params,
    decision,
    outcome: invalid ? "reject" : "allow",
    ...(invalid ? { reason: sessionBoundaryErrorMessage(decision) } : {}),
    eventType: "session_steward.boundary_decision",
  });
  return {
    decision,
    boundary: toGatewaySessionStewardBoundaryFacts(decision),
  };
}

export function assertGatewaySessionStewardBoundary(
  params: GatewaySessionStewardBoundaryParams,
): GatewaySessionStewardBoundaryCheck {
  const resolved = resolveGatewaySessionStewardBoundary(params);
  const invalid =
    resolved.decision.kind === "malformed" || resolved.decision.agentRelation === "cross_agent";
  if (!invalid) {
    return { ok: true, ...resolved };
  }
  const reason = sessionBoundaryErrorMessage(resolved.decision);
  emitSessionStewardBoundaryDecision({
    telemetry: params,
    decision: resolved.decision,
    outcome: "reject",
    reason,
    eventType: "session_steward.boundary_rejected",
  });
  return {
    ok: false,
    ...resolved,
    error: errorShape(ErrorCodes.INVALID_REQUEST, reason, {
      details: { sessionBoundary: resolved.boundary },
    }),
  };
}

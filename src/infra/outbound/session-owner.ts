// Enforces one canonical agent owner across outbound control and transcript metadata.
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  classifySessionKeyShape,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";

type AgentSessionOwnerPair = {
  agentId?: string | null;
  sessionKey?: string | null;
  ownerLabel: string;
  sessionKeyLabel?: string;
};

type AgentSessionOwnershipFailure =
  | {
      reason: "malformed_session_key";
      sessionKey: string;
      message: string;
    }
  | {
      reason: "owner_mismatch";
      agentId: string;
      sessionAgentId: string;
      message: string;
    };

class AgentSessionOwnershipError extends Error {
  readonly failure: AgentSessionOwnershipFailure;

  constructor(failure: AgentSessionOwnershipFailure) {
    super(failure.message);
    this.name = "AgentSessionOwnershipError";
    this.failure = failure;
  }
}

export function validateAgentSessionOwnerPair(
  params: AgentSessionOwnerPair,
): Result<undefined, AgentSessionOwnershipFailure> {
  const sessionKey = normalizeOptionalString(params.sessionKey);
  if (!sessionKey) {
    return ok(undefined);
  }
  const sessionKeyLabel = params.sessionKeyLabel ?? "session key";
  if (classifySessionKeyShape(sessionKey) === "malformed_agent") {
    return err({
      reason: "malformed_session_key",
      sessionKey,
      message: `${params.ownerLabel} ${sessionKeyLabel} "${sessionKey}" is malformed; expected "agent:<agentId>:<session>"`,
    });
  }

  const explicitAgentId = normalizeOptionalString(params.agentId);
  const parsedSessionKey = parseAgentSessionKey(sessionKey);
  if (!explicitAgentId || !parsedSessionKey) {
    return ok(undefined);
  }
  const agentId = normalizeAgentId(explicitAgentId);
  const sessionAgentId = normalizeAgentId(parsedSessionKey.agentId);
  if (agentId === sessionAgentId) {
    return ok(undefined);
  }
  return err({
    reason: "owner_mismatch",
    agentId,
    sessionAgentId,
    message: `${params.ownerLabel} agentId "${agentId}" does not match ${sessionKeyLabel} agent "${sessionAgentId}"`,
  });
}

function validateAgentSessionOwnerPairs(
  pairs: readonly AgentSessionOwnerPair[],
): Result<undefined, AgentSessionOwnershipFailure> {
  let operationAgentId: string | undefined;
  for (const pair of pairs) {
    const result = validateAgentSessionOwnerPair(pair);
    if (!result.ok) {
      return result;
    }

    const sessionKey = normalizeOptionalString(pair.sessionKey);
    const sessionAgentId = sessionKey ? parseAgentSessionKey(sessionKey)?.agentId : undefined;
    const explicitAgentId = normalizeOptionalString(pair.agentId);
    const declaredAgentId = sessionAgentId ?? explicitAgentId;
    if (!declaredAgentId) {
      continue;
    }
    const normalizedDeclaredAgentId = normalizeAgentId(declaredAgentId);
    if (!operationAgentId) {
      operationAgentId = normalizedDeclaredAgentId;
      continue;
    }
    if (normalizedDeclaredAgentId === operationAgentId) {
      continue;
    }
    const declaredOwnerLabel = sessionAgentId
      ? `${pair.sessionKeyLabel ?? "session key"} agent`
      : "agentId";
    return err({
      reason: "owner_mismatch",
      agentId: operationAgentId,
      sessionAgentId: normalizedDeclaredAgentId,
      message: `${pair.ownerLabel} ${declaredOwnerLabel} "${normalizedDeclaredAgentId}" does not match operation agent "${operationAgentId}"`,
    });
  }
  return ok(undefined);
}

export function assertAgentSessionOwnerPairs(pairs: readonly AgentSessionOwnerPair[]): void {
  const result = validateAgentSessionOwnerPairs(pairs);
  if (!result.ok) {
    throw new AgentSessionOwnershipError(result.error);
  }
}

export function validateOutboundDeliverySessionOwnership(params: {
  ownerLabel: string;
  session?: { agentId?: string | null; key?: string | null; policyKey?: string | null };
  mirror?: { agentId?: string | null; sessionKey?: string | null };
}): Result<undefined, AgentSessionOwnershipFailure> {
  // policyKey selects delivery policy and can intentionally name another agent.
  // Canonical control and transcript keys must still share one operation owner.
  return validateAgentSessionOwnerPairs([
    {
      ownerLabel: params.ownerLabel,
      agentId: params.session?.agentId,
      sessionKey: params.session?.key,
    },
    {
      ownerLabel: params.ownerLabel,
      agentId: params.mirror?.agentId,
      sessionKey: params.mirror?.sessionKey,
      sessionKeyLabel: "mirror session key",
    },
  ]);
}

export function assertOutboundDeliverySessionOwnership(params: {
  ownerLabel: string;
  session?: { agentId?: string | null; key?: string | null; policyKey?: string | null };
  mirror?: { agentId?: string | null; sessionKey?: string | null };
}): void {
  const result = validateOutboundDeliverySessionOwnership(params);
  if (!result.ok) {
    throw new AgentSessionOwnershipError(result.error);
  }
}

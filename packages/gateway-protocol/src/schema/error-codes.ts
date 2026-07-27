// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  type CachedAgentResultErrorDetails,
  type ErrorCode,
  type MissingScopeErrorDetails,
} from "../gateway-error-details.js";
import { closedObject } from "./closed-object.js";
import type { ErrorShape } from "./frames.js";
import { NonEmptyString } from "./primitives.js";

export {
  ErrorCodes,
  GatewayErrorDetailCodes,
  type CachedAgentResultErrorDetails,
  type ErrorCode,
  type GatewayErrorDetails,
  type McpAppViewExpiredErrorDetails,
  type MissingScopeErrorDetails,
  type UnknownAgentIdErrorDetails,
  type WizardNotFoundErrorDetails,
  isMcpAppViewExpiredError,
  readCachedAgentResultErrorDetails,
  readMissingScopeError,
  readMissingScopeErrorDetails,
} from "../gateway-error-details.js";

/** Cached agent-result details distinguish replayed terminal failures from RPC failures. */
export const CachedAgentResultErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.CACHED_AGENT_RESULT),
  runId: NonEmptyString,
  requestedRunId: Type.Optional(NonEmptyString),
  originalDetails: Type.Optional(Type.Unknown()),
});

/** Missing operator-scope details shared by WebSocket and HTTP responses. */
export const MissingScopeErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.MISSING_SCOPE),
  missingScope: NonEmptyString,
  requiredScopes: Type.Array(NonEmptyString, { minItems: 1 }),
});

export const McpAppViewExpiredErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED),
});

export const UnknownAgentIdErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.UNKNOWN_AGENT_ID),
  agentId: NonEmptyString,
});

export const WizardNotFoundErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.WIZARD_NOT_FOUND),
});

/**
 * Structured details emitted by method-level failures.
 * Cached agent failures stay additive via their named schema instead of
 * widening this public union.
 */
export const GatewayErrorDetailsSchema = Type.Union([
  MissingScopeErrorDetailsSchema,
  McpAppViewExpiredErrorDetailsSchema,
  UnknownAgentIdErrorDetailsSchema,
  WizardNotFoundErrorDetailsSchema,
]);

/** Builds the canonical gateway error payload while preserving optional retry metadata. */
export function errorShape(
  code: ErrorCode,
  message: string,
  opts?: { details?: unknown; retryable?: boolean; retryAfterMs?: number },
): ErrorShape {
  return {
    code,
    message,
    ...opts,
  };
}

/** Builds the structured marker attached to a replay-only cached failure. */
export function buildCachedAgentResultErrorDetails(params: {
  runId: string;
  requestedRunId?: string;
  originalDetails?: unknown;
}): CachedAgentResultErrorDetails {
  return {
    code: GatewayErrorDetailCodes.CACHED_AGENT_RESULT,
    runId: params.runId,
    ...(params.requestedRunId ? { requestedRunId: params.requestedRunId } : {}),
    ...(params.originalDetails === undefined ? {} : { originalDetails: params.originalDetails }),
  };
}

/** Builds structured details for a missing operator scope. */
export function buildMissingScopeErrorDetails(params: {
  missingScope: string;
  requiredScopes: readonly string[];
}): MissingScopeErrorDetails {
  const requiredScopes =
    params.requiredScopes.length > 0 ? [...params.requiredScopes] : [params.missingScope];
  return {
    code: GatewayErrorDetailCodes.MISSING_SCOPE,
    missingScope: params.missingScope,
    requiredScopes,
  };
}

/** Builds a forbidden error for a missing operator scope without message parsing. */
export function missingScopeErrorShape(params: {
  missingScope: string;
  requiredScopes: readonly string[];
}): ErrorShape {
  const details = buildMissingScopeErrorDetails(params);
  return errorShape(ErrorCodes.FORBIDDEN, `missing scope: ${params.missingScope}`, { details });
}

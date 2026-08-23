// Gateway Protocol schema module defines protocol validation shapes.
import { Type } from "typebox";
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  type ErrorCode,
  type MissingScopeErrorDetails,
} from "../gateway-error-details.js";
import { closedObject } from "./closed-object.js";
import type { ErrorShape } from "./frames.js";
import { NonEmptyString } from "./primitives.js";

export {
  ErrorCodes,
  GatewayErrorDetailCodes,
  type ErrorCode,
  type GatewayErrorDetails,
  type McpAppViewExpiredErrorDetails,
  type MissingScopeErrorDetails,
  type UserPrefsLimitExceededErrorDetails,
  type UnknownAgentIdErrorDetails,
  type WizardNotFoundErrorDetails,
  isMcpAppViewExpiredError,
  readMissingScopeError,
  readMissingScopeErrorDetails,
} from "../gateway-error-details.js";

/** Missing operator-scope details shared by WebSocket and HTTP responses. */
export const MissingScopeErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.MISSING_SCOPE),
  missingScope: NonEmptyString,
  requiredScopes: Type.Array(NonEmptyString, { minItems: 1 }),
});

export const McpAppViewExpiredErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED),
});

export const UserPrefsLimitExceededErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED),
  limit: Type.Integer({ minimum: 1 }),
  currentCount: Type.Integer({ minimum: 0 }),
});

export const UnknownAgentIdErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.UNKNOWN_AGENT_ID),
  agentId: NonEmptyString,
});

export const WizardNotFoundErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.WIZARD_NOT_FOUND),
});

/** Structured details emitted by method-level failures. */
export const GatewayErrorDetailsSchema = Type.Union([
  MissingScopeErrorDetailsSchema,
  McpAppViewExpiredErrorDetailsSchema,
  UserPrefsLimitExceededErrorDetailsSchema,
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

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
  type CronJobNotFoundErrorDetails,
  type ErrorCode,
  type GatewayErrorDetails,
  type McpAppViewExpiredErrorDetails,
  type MissingScopeErrorDetails,
  type SkillProposalRevisionChangedErrorDetails,
  type UserPrefsLimitExceededErrorDetails,
  type ProjectCloneErrorDetails,
  type ProjectCloneFailureCause,
  type UnknownAgentIdErrorDetails,
  type WizardNotFoundErrorDetails,
  readCronJobNotFoundError,
  isMcpAppViewExpiredError,
  readMissingScopeError,
  readMissingScopeErrorDetails,
  buildSkillProposalRevisionChangedErrorDetails,
  readSkillProposalRevisionChangedError,
} from "../gateway-error-details.js";

export const CronJobNotFoundErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND),
  jobId: NonEmptyString,
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

export const ProjectCloneErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.PROJECT_CLONE_FAILED),
  cause: Type.String({
    enum: ["invalid_url", "auth_required", "not_found", "network", "target_exists", "clone_failed"],
  }),
});

const RevisionHashSchema = Type.String({ pattern: "^[a-fA-F0-9]{64}$" });

export const SkillProposalRevisionChangedErrorDetailsSchema = closedObject({
  code: Type.Literal(GatewayErrorDetailCodes.SKILL_PROPOSAL_REVISION_CHANGED),
  expectedRevisionHash: RevisionHashSchema,
  currentRevisionHash: RevisionHashSchema,
});

/** Structured details emitted by method-level failures. */
export const GatewayErrorDetailsSchema = Type.Union([
  CronJobNotFoundErrorDetailsSchema,
  MissingScopeErrorDetailsSchema,
  McpAppViewExpiredErrorDetailsSchema,
  UserPrefsLimitExceededErrorDetailsSchema,
  SkillProposalRevisionChangedErrorDetailsSchema,
  ProjectCloneErrorDetailsSchema,
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

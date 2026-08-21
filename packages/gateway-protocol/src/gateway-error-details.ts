import { asProtocolRecord } from "./protocol-value-normalization.js";

/** Gateway JSON-RPC style error codes shared by clients and server handlers. */
export const ErrorCodes = {
  /** @deprecated Retained for source compatibility; no current server emitter. */
  NOT_LINKED: "NOT_LINKED",
  /** Device exists but still needs an explicit pairing approval. */
  NOT_PAIRED: "NOT_PAIRED",
  /** @deprecated Retained for source compatibility; no current server emitter. */
  AGENT_TIMEOUT: "AGENT_TIMEOUT",
  /** Request payload failed protocol validation or method preconditions. */
  INVALID_REQUEST: "INVALID_REQUEST",
  /** Authenticated caller lacks permission for the requested operation. */
  FORBIDDEN: "FORBIDDEN",
  /** Approval resolution referenced a missing or expired approval request. */
  APPROVAL_NOT_FOUND: "APPROVAL_NOT_FOUND",
  /** Gateway service or required backend is temporarily unavailable. */
  UNAVAILABLE: "UNAVAILABLE",
} as const;

/** Closed set of canonical gateway error code strings. */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Stable discriminants for structured method-level failures. */
export const GatewayErrorDetailCodes = {
  CRON_JOB_NOT_FOUND: "CRON_JOB_NOT_FOUND",
  MISSING_SCOPE: "MISSING_SCOPE",
  MCP_APP_VIEW_EXPIRED: "MCP_APP_VIEW_EXPIRED",
  USER_PREFS_LIMIT_EXCEEDED: "USER_PREFS_LIMIT_EXCEEDED",
  SESSION_COMPANION_BUSY: "SESSION_COMPANION_BUSY",
  SKILL_PROPOSAL_REVISION_CHANGED: "SKILL_PROPOSAL_REVISION_CHANGED",
  PROJECT_CLONE_FAILED: "PROJECT_CLONE_FAILED",
  UNKNOWN_AGENT_ID: "UNKNOWN_AGENT_ID",
  WIZARD_NOT_FOUND: "WIZARD_NOT_FOUND",
} as const;

/** Missing cron automation identified by its exact store key. */
export type CronJobNotFoundErrorDetails = {
  code: typeof GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND;
  jobId: string;
};

/** Missing operator-scope details shared by WebSocket and HTTP responses. */
export type MissingScopeErrorDetails = {
  code: typeof GatewayErrorDetailCodes.MISSING_SCOPE;
  missingScope: string;
  requiredScopes: string[];
};

export type McpAppViewExpiredErrorDetails = {
  code: typeof GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED;
};

/** Per-profile preference quota details returned by users.prefs.set. */
export type UserPrefsLimitExceededErrorDetails = {
  code: typeof GatewayErrorDetailCodes.USER_PREFS_LIMIT_EXCEEDED;
  limit: number;
  currentCount: number;
};

/** Unknown agent details carried by agent-scoped method validation failures. */
export type UnknownAgentIdErrorDetails = {
  code: typeof GatewayErrorDetailCodes.UNKNOWN_AGENT_ID;
  agentId: string;
};

/** Missing or expired process-local setup wizard session. */
export type WizardNotFoundErrorDetails = {
  code: typeof GatewayErrorDetailCodes.WIZARD_NOT_FOUND;
};

export type ProjectCloneFailureCause =
  | "invalid_url"
  | "auth_required"
  | "not_found"
  | "network"
  | "target_exists"
  | "clone_failed";

export type ProjectCloneErrorDetails = {
  code: typeof GatewayErrorDetailCodes.PROJECT_CLONE_FAILED;
  cause: ProjectCloneFailureCause;
};

/** Optimistic-concurrency mismatch for an operator-reviewed Skill Workshop draft. */
export type SkillProposalRevisionChangedErrorDetails = {
  code: typeof GatewayErrorDetailCodes.SKILL_PROPOSAL_REVISION_CHANGED;
  expectedRevisionHash: string;
  currentRevisionHash: string;
};

/** Structured details emitted by method-level failures. */
export type GatewayErrorDetails =
  | CronJobNotFoundErrorDetails
  | MissingScopeErrorDetails
  | McpAppViewExpiredErrorDetails
  | UserPrefsLimitExceededErrorDetails
  | SkillProposalRevisionChangedErrorDetails
  | ProjectCloneErrorDetails
  | UnknownAgentIdErrorDetails
  | WizardNotFoundErrorDetails;

type GatewayErrorLike = {
  code?: unknown;
  gatewayCode?: unknown;
  message?: unknown;
  details?: unknown;
};

const LEGACY_MISSING_SCOPE_PATTERN = /\bmissing scope:\s*([a-z0-9._-]+)/i;
const SHA256_PATTERN = /^[a-fA-F0-9]{64}$/;

/** Reads a typed cron lookup miss without parsing operator-facing prose. */
export function readCronJobNotFoundError(error: unknown): CronJobNotFoundErrorDetails | null {
  const record = asProtocolRecord(error);
  const details = asProtocolRecord(record?.details);
  if (details?.code !== GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND) {
    return null;
  }
  const jobId = typeof details.jobId === "string" ? details.jobId.trim() : "";
  return jobId ? { code: GatewayErrorDetailCodes.CRON_JOB_NOT_FOUND, jobId } : null;
}

/** Builds the canonical stale-draft details shared by Skill Workshop RPCs. */
export function buildSkillProposalRevisionChangedErrorDetails(params: {
  expectedRevisionHash: string;
  currentRevisionHash: string;
}): SkillProposalRevisionChangedErrorDetails {
  return {
    code: GatewayErrorDetailCodes.SKILL_PROPOSAL_REVISION_CHANGED,
    expectedRevisionHash: params.expectedRevisionHash,
    currentRevisionHash: params.currentRevisionHash,
  };
}

/** Reads a stale Skill Workshop decision without parsing operator-facing prose. */
export function readSkillProposalRevisionChangedError(
  error: unknown,
): SkillProposalRevisionChangedErrorDetails | null {
  const record = asProtocolRecord(error);
  const details = asProtocolRecord(record?.details);
  if (details?.code !== GatewayErrorDetailCodes.SKILL_PROPOSAL_REVISION_CHANGED) {
    return null;
  }
  const expectedRevisionHash =
    typeof details.expectedRevisionHash === "string" ? details.expectedRevisionHash : "";
  const currentRevisionHash =
    typeof details.currentRevisionHash === "string" ? details.currentRevisionHash : "";
  if (!SHA256_PATTERN.test(expectedRevisionHash) || !SHA256_PATTERN.test(currentRevisionHash)) {
    return null;
  }
  return buildSkillProposalRevisionChangedErrorDetails({
    expectedRevisionHash,
    currentRevisionHash,
  });
}

/** Reads validated missing-scope details from an untrusted protocol payload. */
export function readMissingScopeErrorDetails(details: unknown): MissingScopeErrorDetails | null {
  const record = asProtocolRecord(details);
  if (record?.code !== GatewayErrorDetailCodes.MISSING_SCOPE) {
    return null;
  }
  const missingScope = typeof record.missingScope === "string" ? record.missingScope.trim() : "";
  const requiredScopes = Array.isArray(record.requiredScopes)
    ? record.requiredScopes.map((scope) => (typeof scope === "string" ? scope.trim() : ""))
    : [];
  if (!missingScope || requiredScopes.length === 0 || requiredScopes.some((scope) => !scope)) {
    return null;
  }
  return {
    code: GatewayErrorDetailCodes.MISSING_SCOPE,
    missingScope,
    requiredScopes,
  };
}

export function isMcpAppViewExpiredError(error: unknown): boolean {
  const record = asProtocolRecord(error);
  return asProtocolRecord(record?.details)?.code === GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED;
}

/**
 * Reads a method-level missing-scope failure, preferring structured details.
 * The message fallback keeps clients compatible with gateways predating structured details.
 */
export function readMissingScopeError(error: unknown): MissingScopeErrorDetails | null {
  const record = asProtocolRecord(error);
  if (!record) {
    return null;
  }
  const structured = readMissingScopeErrorDetails(record.details);
  if (structured) {
    return structured;
  }
  const gatewayError = record as GatewayErrorLike;
  const code =
    typeof gatewayError.gatewayCode === "string"
      ? gatewayError.gatewayCode
      : typeof gatewayError.code === "string"
        ? gatewayError.code
        : "";
  if (code !== ErrorCodes.FORBIDDEN && code !== ErrorCodes.INVALID_REQUEST) {
    return null;
  }
  const message = typeof gatewayError.message === "string" ? gatewayError.message : "";
  const missingScope = message.match(LEGACY_MISSING_SCOPE_PATTERN)?.[1];
  return missingScope
    ? {
        code: GatewayErrorDetailCodes.MISSING_SCOPE,
        missingScope,
        requiredScopes: [missingScope],
      }
    : null;
}

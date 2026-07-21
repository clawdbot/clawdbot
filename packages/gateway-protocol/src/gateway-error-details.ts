/** Gateway JSON-RPC style error codes shared by clients and server handlers. */
export const ErrorCodes = {
  /** Client has not completed account/device linking for this gateway. */
  NOT_LINKED: "NOT_LINKED",
  /** Device exists but still needs an explicit pairing approval. */
  NOT_PAIRED: "NOT_PAIRED",
  /** Agent turn exceeded the gateway wait window. */
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

/** Stable discriminants for structured method-level authorization failures. */
export const GatewayErrorDetailCodes = {
  MISSING_SCOPE: "MISSING_SCOPE",
  MCP_APP_VIEW_EXPIRED: "MCP_APP_VIEW_EXPIRED",
  UNKNOWN_AGENT_ID: "UNKNOWN_AGENT_ID",
} as const;

/** Missing operator-scope details shared by WebSocket and HTTP responses. */
export type MissingScopeErrorDetails = {
  code: typeof GatewayErrorDetailCodes.MISSING_SCOPE;
  missingScope: string;
  requiredScopes: string[];
};

export type McpAppViewExpiredErrorDetails = {
  code: typeof GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED;
};

/** Unknown agent details carried by agent-scoped method validation failures. */
export type UnknownAgentIdErrorDetails = {
  code: typeof GatewayErrorDetailCodes.UNKNOWN_AGENT_ID;
  agentId: string;
};

/** Structured details emitted by method-level authorization failures. */
export type GatewayErrorDetails =
  | MissingScopeErrorDetails
  | McpAppViewExpiredErrorDetails
  | UnknownAgentIdErrorDetails;

type GatewayErrorLike = {
  code?: unknown;
  gatewayCode?: unknown;
  message?: unknown;
  details?: unknown;
};

const LEGACY_MISSING_SCOPE_PATTERN = /\bmissing scope:\s*([a-z0-9._-]+)/i;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Reads validated missing-scope details from an untrusted protocol payload. */
export function readMissingScopeErrorDetails(details: unknown): MissingScopeErrorDetails | null {
  const record = asRecord(details);
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
  const record = asRecord(error);
  return asRecord(record?.details)?.code === GatewayErrorDetailCodes.MCP_APP_VIEW_EXPIRED;
}

/**
 * Reads a method-level missing-scope failure, preferring structured details.
 * The message fallback keeps clients compatible with gateways predating structured details.
 */
export function readMissingScopeError(error: unknown): MissingScopeErrorDetails | null {
  const record = asRecord(error);
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

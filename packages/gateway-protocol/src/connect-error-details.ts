/**
 * Shared gateway connect-error detail helpers.
 *
 * These details cross client/server boundaries, so readers normalize untrusted
 * payloads before using them in reconnect decisions or user-facing messages.
 */
import { normalizeOptionalProtocolString } from "./protocol-value-normalization.js";

function normalizeOptionalConnectDetailStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value
    .map((entry) => normalizeOptionalProtocolString(entry))
    .filter((entry): entry is string => Boolean(entry));
  // Pairing details omit absent lists. Emitting empty arrays makes clients think
  // the gateway intentionally supplied scope/role context when it did not.
  return values.length > 0 ? values : undefined;
}

/** Structured connect-error codes carried in gateway error `details.code`. */
export const ConnectErrorDetailCodes = {
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_UNAUTHORIZED: "AUTH_UNAUTHORIZED",
  AUTH_TOKEN_MISSING: "AUTH_TOKEN_MISSING",
  AUTH_TOKEN_MISMATCH: "AUTH_TOKEN_MISMATCH",
  AUTH_TOKEN_NOT_CONFIGURED: "AUTH_TOKEN_NOT_CONFIGURED",
  AUTH_PASSWORD_MISSING: "AUTH_PASSWORD_MISSING", // pragma: allowlist secret
  AUTH_PASSWORD_MISMATCH: "AUTH_PASSWORD_MISMATCH", // pragma: allowlist secret
  AUTH_PASSWORD_NOT_CONFIGURED: "AUTH_PASSWORD_NOT_CONFIGURED", // pragma: allowlist secret
  AUTH_BOOTSTRAP_TOKEN_INVALID: "AUTH_BOOTSTRAP_TOKEN_INVALID",
  AUTH_DEVICE_TOKEN_MISMATCH: "AUTH_DEVICE_TOKEN_MISMATCH",
  AUTH_SCOPE_MISMATCH: "AUTH_SCOPE_MISMATCH",
  AUTH_RATE_LIMITED: "AUTH_RATE_LIMITED",
  AUTH_TAILSCALE_IDENTITY_MISSING: "AUTH_TAILSCALE_IDENTITY_MISSING",
  AUTH_TAILSCALE_PROXY_MISSING: "AUTH_TAILSCALE_PROXY_MISSING",
  AUTH_TAILSCALE_WHOIS_FAILED: "AUTH_TAILSCALE_WHOIS_FAILED",
  AUTH_TAILSCALE_IDENTITY_MISMATCH: "AUTH_TAILSCALE_IDENTITY_MISMATCH",
  CONTROL_UI_BUILD_MISMATCH: "CONTROL_UI_BUILD_MISMATCH",
  CONTROL_UI_ORIGIN_NOT_ALLOWED: "CONTROL_UI_ORIGIN_NOT_ALLOWED",
  PROTOCOL_MISMATCH: "PROTOCOL_MISMATCH",
  CONTROL_UI_DEVICE_IDENTITY_REQUIRED: "CONTROL_UI_DEVICE_IDENTITY_REQUIRED",
  DEVICE_IDENTITY_REQUIRED: "DEVICE_IDENTITY_REQUIRED",
  DEVICE_AUTH_INVALID: "DEVICE_AUTH_INVALID",
  DEVICE_AUTH_DEVICE_ID_MISMATCH: "DEVICE_AUTH_DEVICE_ID_MISMATCH",
  DEVICE_AUTH_SIGNATURE_EXPIRED: "DEVICE_AUTH_SIGNATURE_EXPIRED",
  DEVICE_AUTH_NONCE_REQUIRED: "DEVICE_AUTH_NONCE_REQUIRED",
  DEVICE_AUTH_NONCE_MISMATCH: "DEVICE_AUTH_NONCE_MISMATCH",
  DEVICE_AUTH_SIGNATURE_INVALID: "DEVICE_AUTH_SIGNATURE_INVALID",
  DEVICE_AUTH_PUBLIC_KEY_INVALID: "DEVICE_AUTH_PUBLIC_KEY_INVALID",
  PAIRING_REQUIRED: "PAIRING_REQUIRED",
  CLIENT_VERSION_MISMATCH: "CLIENT_VERSION_MISMATCH",
} as const;

type ConnectErrorDetailCode =
  (typeof ConnectErrorDetailCodes)[keyof typeof ConnectErrorDetailCodes];

/** Pairing-specific reasons clients can display and use for reconnect policy. */
const ConnectPairingRequiredReasons = {
  NOT_PAIRED: "not-paired",
  ROLE_UPGRADE: "role-upgrade",
  SCOPE_UPGRADE: "scope-upgrade",
  METADATA_UPGRADE: "metadata-upgrade",
} as const;

export type ConnectPairingRequiredReason =
  (typeof ConnectPairingRequiredReasons)[keyof typeof ConnectPairingRequiredReasons];

/** Suggested client-side recovery action for structured connect errors. */
type ConnectRecoveryNextStep =
  | "retry_with_device_token"
  | "update_auth_configuration"
  | "update_auth_credentials"
  | "wait_then_retry"
  | "review_auth_configuration";

/** Optional retry guidance extracted from gateway connect-error details. */
type ConnectErrorRecoveryAdvice = {
  canRetryWithDeviceToken?: boolean;
  recommendedNextStep?: ConnectRecoveryNextStep;
};

/** Full structured details for pairing-required connect failures. */
type PairingConnectErrorDetails = {
  code: typeof ConnectErrorDetailCodes.PAIRING_REQUIRED;
  reason?: ConnectPairingRequiredReason;
  requestId?: string;
  remediationHint?: string;
  recommendedNextStep?: ConnectRecoveryNextStep;
  retryable?: boolean;
  pauseReconnect?: boolean;
  deviceId?: string;
  requestedRole?: string;
  requestedScopes?: string[];
  approvedRoles?: string[];
  approvedScopes?: string[];
};

/** Compact pairing-required subset used by reconnect/status surfaces. */
export type ConnectPairingRequiredDetails = Pick<
  PairingConnectErrorDetails,
  "reason" | "requestId"
>;

const CONNECT_RECOVERY_NEXT_STEP_VALUES: ReadonlySet<ConnectRecoveryNextStep> = new Set([
  "retry_with_device_token",
  "update_auth_configuration",
  "update_auth_credentials",
  "wait_then_retry",
  "review_auth_configuration",
]);

const CONNECT_PAIRING_REQUIRED_REASON_VALUES: ReadonlySet<ConnectPairingRequiredReason> = new Set([
  "not-paired",
  "role-upgrade",
  "scope-upgrade",
  "metadata-upgrade",
]);
const PAIRING_CONNECT_REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const PAIRING_CONNECT_REASON_METADATA: Readonly<
  Record<
    ConnectPairingRequiredReason,
    {
      requirement: string;
      remediationHint: string;
      recoveryTitle: string;
    }
  >
> = {
  "not-paired": {
    requirement: "device is not approved yet",
    remediationHint: "Approve this device from the pending pairing requests.",
    recoveryTitle: "Gateway pairing approval required.",
  },
  "role-upgrade": {
    requirement: "device is asking for a higher role than currently approved",
    remediationHint: "Review the requested role upgrade, then approve the pending request.",
    recoveryTitle: "Gateway role upgrade approval required.",
  },
  "scope-upgrade": {
    requirement: "device is asking for more scopes than currently approved",
    remediationHint: "Review the requested scopes, then approve the pending upgrade.",
    recoveryTitle: "Gateway scope upgrade approval required.",
  },
  "metadata-upgrade": {
    requirement: "device identity changed and must be re-approved",
    remediationHint: "Review the refreshed device details, then approve the pending request.",
    recoveryTitle: "Gateway device refresh approval required.",
  },
};

const CONNECT_PAIRING_REQUIRED_MESSAGE_BY_REASON: Readonly<
  Record<ConnectPairingRequiredReason, string>
> = {
  "not-paired": "device pairing required",
  "role-upgrade": "role upgrade pending approval",
  "scope-upgrade": "scope upgrade pending approval",
  "metadata-upgrade": "device metadata change pending approval",
};

/** Maps internal auth failure reasons to public connect-error detail codes. */
export function resolveAuthConnectErrorDetailCode(
  reason: string | undefined,
): ConnectErrorDetailCode {
  switch (reason) {
    case "token_missing":
      return ConnectErrorDetailCodes.AUTH_TOKEN_MISSING;
    case "token_mismatch":
      return ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH;
    case "token_missing_config":
      return ConnectErrorDetailCodes.AUTH_TOKEN_NOT_CONFIGURED;
    case "password_missing":
      return ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING;
    case "password_mismatch":
      return ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH;
    case "password_missing_config":
      return ConnectErrorDetailCodes.AUTH_PASSWORD_NOT_CONFIGURED;
    case "bootstrap_token_invalid":
      return ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID;
    case "tailscale_user_missing":
      return ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISSING;
    case "tailscale_proxy_missing":
      return ConnectErrorDetailCodes.AUTH_TAILSCALE_PROXY_MISSING;
    case "tailscale_whois_failed":
      return ConnectErrorDetailCodes.AUTH_TAILSCALE_WHOIS_FAILED;
    case "tailscale_user_mismatch":
      return ConnectErrorDetailCodes.AUTH_TAILSCALE_IDENTITY_MISMATCH;
    case "rate_limited":
      return ConnectErrorDetailCodes.AUTH_RATE_LIMITED;
    case "device_token_mismatch":
      return ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH;
    case "scope_mismatch":
      return ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH;
    case undefined:
      return ConnectErrorDetailCodes.AUTH_REQUIRED;
    default:
      return ConnectErrorDetailCodes.AUTH_UNAUTHORIZED;
  }
}

/** Maps device-auth verifier reasons to public connect-error detail codes. */
export function resolveDeviceAuthConnectErrorDetailCode(
  reason: string | undefined,
): ConnectErrorDetailCode {
  switch (reason) {
    case "device-id-mismatch":
      return ConnectErrorDetailCodes.DEVICE_AUTH_DEVICE_ID_MISMATCH;
    case "device-signature-stale":
      return ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_EXPIRED;
    case "device-nonce-missing":
      return ConnectErrorDetailCodes.DEVICE_AUTH_NONCE_REQUIRED;
    case "device-nonce-mismatch":
      return ConnectErrorDetailCodes.DEVICE_AUTH_NONCE_MISMATCH;
    case "device-signature":
      return ConnectErrorDetailCodes.DEVICE_AUTH_SIGNATURE_INVALID;
    case "device-public-key":
      return ConnectErrorDetailCodes.DEVICE_AUTH_PUBLIC_KEY_INVALID;
    default:
      return ConnectErrorDetailCodes.DEVICE_AUTH_INVALID;
  }
}

/** Reads a non-empty detail code from an untrusted error details payload. */
export function readConnectErrorDetailCode(details: unknown): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  const code = (details as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code.trim() : null;
}

/** Read the exact target artifact from an untrusted reload-required rejection. */
export function readControlUiBuildMismatchId(details: unknown): string | null {
  if (readConnectErrorDetailCode(details) !== ConnectErrorDetailCodes.CONTROL_UI_BUILD_MISMATCH) {
    return null;
  }
  const raw = details as { gatewayBuildId?: unknown; reloadRequired?: unknown };
  const gatewayBuildId = normalizeOptionalProtocolString(raw.gatewayBuildId);
  if (!gatewayBuildId || gatewayBuildId.length > 96 || raw.reloadRequired !== true) {
    return null;
  }
  return gatewayBuildId;
}

/** Extracts normalized retry advice from untrusted connect-error details. */
export function readConnectErrorRecoveryAdvice(details: unknown): ConnectErrorRecoveryAdvice {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return {};
  }
  const raw = details as {
    canRetryWithDeviceToken?: unknown;
    recommendedNextStep?: unknown;
  };
  const canRetryWithDeviceToken =
    typeof raw.canRetryWithDeviceToken === "boolean" ? raw.canRetryWithDeviceToken : undefined;
  const normalizedNextStep = normalizeOptionalProtocolString(raw.recommendedNextStep) ?? "";
  const recommendedNextStep = CONNECT_RECOVERY_NEXT_STEP_VALUES.has(
    normalizedNextStep as ConnectRecoveryNextStep,
  )
    ? (normalizedNextStep as ConnectRecoveryNextStep)
    : undefined;
  return {
    canRetryWithDeviceToken,
    recommendedNextStep,
  };
}

function normalizePairingConnectReason(value: unknown): ConnectPairingRequiredReason | undefined {
  const normalized = normalizeOptionalProtocolString(value) ?? "";
  return CONNECT_PAIRING_REQUIRED_REASON_VALUES.has(normalized as ConnectPairingRequiredReason)
    ? (normalized as ConnectPairingRequiredReason)
    : undefined;
}

/** Normalizes pairing request ids before echoing them in close reasons or UI text. */
export function normalizePairingConnectRequestId(value: unknown): string | undefined {
  const normalized = normalizeOptionalProtocolString(value);
  return normalized && PAIRING_CONNECT_REQUEST_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  return normalizeOptionalConnectDetailStringList(value);
}

function createPairingConnectErrorDetails(params: {
  reason?: ConnectPairingRequiredReason;
  requestId?: string;
  remediationHint?: string;
  recommendedNextStep?: ConnectRecoveryNextStep;
  retryable?: boolean;
  pauseReconnect?: boolean;
  deviceId?: string;
  requestedRole?: string;
  requestedScopes?: string[];
  approvedRoles?: string[];
  approvedScopes?: string[];
}): PairingConnectErrorDetails {
  return {
    code: ConnectErrorDetailCodes.PAIRING_REQUIRED,
    ...(params.reason ? { reason: params.reason } : {}),
    ...(params.requestId ? { requestId: params.requestId } : {}),
    ...(params.remediationHint ? { remediationHint: params.remediationHint } : {}),
    ...(params.recommendedNextStep ? { recommendedNextStep: params.recommendedNextStep } : {}),
    ...(params.retryable !== undefined ? { retryable: params.retryable } : {}),
    ...(params.pauseReconnect !== undefined ? { pauseReconnect: params.pauseReconnect } : {}),
    ...(params.deviceId ? { deviceId: params.deviceId } : {}),
    ...(params.requestedRole ? { requestedRole: params.requestedRole } : {}),
    ...(params.requestedScopes ? { requestedScopes: params.requestedScopes } : {}),
    ...(params.approvedRoles ? { approvedRoles: params.approvedRoles } : {}),
    ...(params.approvedScopes ? { approvedScopes: params.approvedScopes } : {}),
  };
}

/** Human-readable requirement summary for a pairing-required reason. */
export function describePairingConnectRequirement(
  reason: ConnectPairingRequiredReason | undefined,
): string {
  return reason
    ? PAIRING_CONNECT_REASON_METADATA[reason].requirement
    : "device approval is required";
}

/** Builds the gateway close/error message for a pairing-required connect failure. */
export function buildPairingConnectErrorMessage(
  reason: ConnectPairingRequiredReason | undefined,
): string {
  return reason
    ? `pairing required: ${describePairingConnectRequirement(reason)}`
    : "pairing required";
}

function buildPairingConnectRemediationHint(
  reason: ConnectPairingRequiredReason | undefined,
): string {
  return reason
    ? PAIRING_CONNECT_REASON_METADATA[reason].remediationHint
    : "Approve the pending device request before retrying.";
}

/** Short user-facing recovery title for pairing-required connect failures. */
export function buildPairingConnectRecoveryTitle(
  reason: ConnectPairingRequiredReason | undefined,
): string {
  return reason
    ? PAIRING_CONNECT_REASON_METADATA[reason].recoveryTitle
    : "Gateway pairing approval required.";
}

/** Builds sanitized structured details for a pairing-required connect failure. */
export function buildPairingConnectErrorDetails(params: {
  reason: ConnectPairingRequiredReason | undefined;
  requestId?: string;
  remediationHint?: string;
  recommendedNextStep?: ConnectRecoveryNextStep;
  retryable?: boolean;
  pauseReconnect?: boolean;
  deviceId?: string;
  requestedRole?: string;
  requestedScopes?: string[];
  approvedRoles?: string[];
  approvedScopes?: string[];
}): PairingConnectErrorDetails {
  const requestId = normalizePairingConnectRequestId(params.requestId);
  const remediationHint =
    normalizeOptionalProtocolString(params.remediationHint) ??
    buildPairingConnectRemediationHint(params.reason);
  const deviceId = normalizeOptionalProtocolString(params.deviceId);
  const requestedRole = normalizeOptionalProtocolString(params.requestedRole);
  const requestedScopes = normalizeStringArray(params.requestedScopes);
  const approvedRoles = normalizeStringArray(params.approvedRoles);
  const approvedScopes = normalizeStringArray(params.approvedScopes);
  return createPairingConnectErrorDetails({
    reason: params.reason,
    requestId,
    remediationHint,
    recommendedNextStep: params.recommendedNextStep,
    retryable: params.retryable,
    pauseReconnect: params.pauseReconnect,
    deviceId,
    requestedRole,
    requestedScopes,
    approvedRoles,
    approvedScopes,
  });
}

/** Builds a sanitized close reason string for WebSocket pairing rejections. */
export function buildPairingConnectCloseReason(params: {
  reason: ConnectPairingRequiredReason | undefined;
  requestId?: string;
}): string {
  const requestId = normalizePairingConnectRequestId(params.requestId);
  const message = buildPairingConnectErrorMessage(params.reason);
  return requestId ? `${message} (requestId: ${requestId})` : message;
}

/** Reads and backfills pairing-required details from an untrusted details object. */
export function readPairingConnectErrorDetails(
  details: unknown,
): PairingConnectErrorDetails | null {
  if (readConnectErrorDetailCode(details) !== ConnectErrorDetailCodes.PAIRING_REQUIRED) {
    return null;
  }
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  const raw = details as {
    reason?: unknown;
    requestId?: unknown;
    remediationHint?: unknown;
    recommendedNextStep?: unknown;
    retryable?: unknown;
    pauseReconnect?: unknown;
    deviceId?: unknown;
    requestedRole?: unknown;
    requestedScopes?: unknown;
    approvedRoles?: unknown;
    approvedScopes?: unknown;
  };
  const reason = normalizePairingConnectReason(raw.reason);
  const requestId = normalizePairingConnectRequestId(raw.requestId);
  const remediationHint =
    normalizeOptionalProtocolString(raw.remediationHint) ??
    buildPairingConnectRemediationHint(reason);
  const normalizedNextStep = normalizeOptionalProtocolString(raw.recommendedNextStep) ?? "";
  const recommendedNextStep = CONNECT_RECOVERY_NEXT_STEP_VALUES.has(
    normalizedNextStep as ConnectRecoveryNextStep,
  )
    ? (normalizedNextStep as ConnectRecoveryNextStep)
    : undefined;
  const deviceId = normalizeOptionalProtocolString(raw.deviceId);
  const requestedRole = normalizeOptionalProtocolString(raw.requestedRole);
  const requestedScopes = normalizeStringArray(raw.requestedScopes);
  const approvedRoles = normalizeStringArray(raw.approvedRoles);
  const approvedScopes = normalizeStringArray(raw.approvedScopes);
  return createPairingConnectErrorDetails({
    reason,
    requestId,
    remediationHint,
    recommendedNextStep,
    retryable: typeof raw.retryable === "boolean" ? raw.retryable : undefined,
    pauseReconnect: typeof raw.pauseReconnect === "boolean" ? raw.pauseReconnect : undefined,
    deviceId,
    requestedRole,
    requestedScopes,
    approvedRoles,
    approvedScopes,
  });
}

/** Parses legacy/string-only pairing-required messages into structured details. */
export function readConnectPairingRequiredMessage(
  message: string | null | undefined,
): ConnectPairingRequiredDetails | null {
  const normalizedMessage = normalizeOptionalProtocolString(message);
  if (!normalizedMessage) {
    return null;
  }
  const normalized = normalizedMessage.trim().toLowerCase();
  let reason: ConnectPairingRequiredReason | undefined;
  for (const [candidate, prefix] of Object.entries(
    CONNECT_PAIRING_REQUIRED_MESSAGE_BY_REASON,
  ) as Array<[ConnectPairingRequiredReason, string]>) {
    if (normalized.includes(prefix)) {
      reason = candidate;
      break;
    }
  }
  if (!reason && normalized.includes("pairing required")) {
    reason = ConnectPairingRequiredReasons.NOT_PAIRED;
  }
  if (!reason) {
    return null;
  }
  const requestId = normalizePairingConnectRequestId(
    normalizedMessage.match(/\(requestId:\s*([^\s)]+)\)/i)?.[1],
  );
  return {
    ...(requestId ? { requestId } : {}),
    reason,
  };
}

const PAIRING_APPROVAL_REMEDIATION =
  "Run `openclaw devices approve --latest` to preview the pending request, then rerun the printed " +
  "`openclaw devices approve <requestId>` command and reconnect (pass the same --url and " +
  "--token/--password flags if you connected with explicit credentials).";
const DEVICE_TOKEN_REMEDIATION =
  "Rotate the paired-device token with `openclaw devices rotate --device <deviceId> --role operator`, then reconnect.";
const SHARED_TOKEN_REMEDIATION =
  "Verify `gateway.remote.token` matches `gateway.auth.token`. If a paired-device token is stale, " +
  "rotate it with `openclaw devices rotate --device <deviceId> --role operator`, then reconnect.";
const SCOPE_MISMATCH_REMEDIATION =
  "Review approved scopes with `openclaw devices list`; if an upgrade is pending, preview it with " +
  "`openclaw devices approve --latest`, approve the printed request, then reconnect.";
const RATE_LIMITED_REMEDIATION =
  "Wait for the temporary authentication lockout to expire, then retry.";
const GATEWAY_CLOSED_MESSAGE_PATTERN = /\bgateway closed \(\d+\):/i;

/** Classifies Gateway connect failures from structured details, with one legacy text fallback. */
export function classifyGatewayConnectFailure(input: {
  details?: unknown;
  reason?: string | null;
  message?: string | null;
}) {
  const code = readConnectErrorDetailCode(input.details);
  const message = normalizeOptionalProtocolString(input.message);
  const reason = normalizeOptionalProtocolString(input.reason);
  const userMessage = message ?? reason;
  const classificationText = [message, reason]
    .filter((value): value is string => Boolean(value))
    .join("\n");
  const normalized = classificationText.toLowerCase();
  const pairing =
    readPairingConnectErrorDetails(input.details) ??
    readConnectPairingRequiredMessage(classificationText);
  if (code === ConnectErrorDetailCodes.PAIRING_REQUIRED || pairing) {
    return {
      kind: "pairing-required" as const,
      userMessage:
        code === ConnectErrorDetailCodes.PAIRING_REQUIRED
          ? formatConnectPairingRequiredMessage(input.details)
          : (userMessage ?? "device pairing required"),
      remediation: PAIRING_APPROVAL_REMEDIATION,
    };
  }
  const deviceIdentityRequired =
    code === ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED ||
    code === ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED ||
    normalized.includes("device identity required");
  const scopeMismatch =
    code === ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH || normalized.includes("scope mismatch");
  const rateLimited =
    code === ConnectErrorDetailCodes.AUTH_RATE_LIMITED ||
    (!code && normalized.includes("too many failed authentication attempts"));
  const deviceTokenMismatch =
    code === ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH ||
    normalized.includes("device token mismatch");
  const sharedTokenMismatch =
    code === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH ||
    normalized.includes("gateway token mismatch");
  const authRejected =
    deviceTokenMismatch ||
    sharedTokenMismatch ||
    code?.startsWith("AUTH_") ||
    code?.startsWith("DEVICE_AUTH_");
  const kind = deviceIdentityRequired
    ? ("device-identity-required" as const)
    : scopeMismatch
      ? ("scope-mismatch" as const)
      : rateLimited
        ? ("rate-limited" as const)
        : authRejected
          ? ("auth-rejected" as const)
          : code || GATEWAY_CLOSED_MESSAGE_PATTERN.test(classificationText)
            ? ("gateway-rejected" as const)
            : ("unreachable" as const);
  const remediation = rateLimited
    ? RATE_LIMITED_REMEDIATION
    : scopeMismatch
      ? SCOPE_MISMATCH_REMEDIATION
      : deviceTokenMismatch
        ? DEVICE_TOKEN_REMEDIATION
        : sharedTokenMismatch
          ? SHARED_TOKEN_REMEDIATION
          : undefined;
  return {
    kind,
    userMessage:
      userMessage ??
      (kind === "unreachable" ? "gateway unreachable" : "gateway rejected connection"),
    ...(remediation ? { remediation } : {}),
  };
}

/** Formats pairing-required details into the canonical user-facing message. */
export function formatConnectPairingRequiredMessage(details: unknown): string {
  const pairing = readPairingConnectErrorDetails(details);
  const base =
    CONNECT_PAIRING_REQUIRED_MESSAGE_BY_REASON[
      pairing?.reason ?? ConnectPairingRequiredReasons.NOT_PAIRED
    ];
  return pairing?.requestId ? `${base} (requestId: ${pairing.requestId})` : base;
}

/** Formats connect errors using structured details before falling back to raw messages. */
export function formatConnectErrorMessage(params: { message?: string; details?: unknown }): string {
  if (readConnectErrorDetailCode(params.details) === ConnectErrorDetailCodes.PAIRING_REQUIRED) {
    return formatConnectPairingRequiredMessage(params.details);
  }
  if (readConnectErrorDetailCode(params.details) === ConnectErrorDetailCodes.PROTOCOL_MISMATCH) {
    return formatProtocolMismatchMessage(params.message, params.details);
  }
  return normalizeOptionalProtocolString(params.message) ?? "gateway request failed";
}

function formatProtocolMismatchMessage(message: string | undefined, details: unknown): string {
  const raw = details as {
    clientMinProtocol?: unknown;
    clientMaxProtocol?: unknown;
    expectedProtocol?: unknown;
    minimumProbeProtocol?: unknown;
  };
  const clientMin = normalizeProtocolNumber(raw.clientMinProtocol);
  const clientMax = normalizeProtocolNumber(raw.clientMaxProtocol);
  const expected = normalizeProtocolNumber(raw.expectedProtocol);
  const probeMin = normalizeProtocolNumber(raw.minimumProbeProtocol);
  const parts: string[] = [];
  if (clientMin !== undefined && clientMax !== undefined) {
    parts.push(
      clientMin === clientMax
        ? `Control UI v${clientMin}`
        : `Control UI v${clientMin}-v${clientMax}`,
    );
  }
  if (expected !== undefined) {
    parts.push(`Gateway v${expected}`);
  }
  if (probeMin !== undefined) {
    parts.push(`probe min v${probeMin}`);
  }
  const normalized = normalizeOptionalProtocolString(message) ?? "protocol mismatch";
  return parts.length > 0 ? `${normalized}: ${parts.join(", ")}` : normalized;
}

function normalizeProtocolNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

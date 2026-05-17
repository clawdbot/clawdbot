import { normalizeOptionalString } from "../../shared/string-coerce.js";

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
} as const;

export type ConnectErrorDetailCode =
  (typeof ConnectErrorDetailCodes)[keyof typeof ConnectErrorDetailCodes];

export const ConnectPairingRequiredReasons = {
  NOT_PAIRED: "not-paired",
  ROLE_UPGRADE: "role-upgrade",
  SCOPE_UPGRADE: "scope-upgrade",
  METADATA_UPGRADE: "metadata-upgrade",
} as const;

export type ConnectPairingRequiredReason =
  (typeof ConnectPairingRequiredReasons)[keyof typeof ConnectPairingRequiredReasons];

export type ConnectRecoveryNextStep =
  | "retry_with_device_token"
  | "update_auth_configuration"
  | "update_auth_credentials"
  | "wait_then_retry"
  | "review_auth_configuration";

export type ConnectErrorRecoveryAdvice = {
  canRetryWithDeviceToken?: boolean;
  recommendedNextStep?: ConnectRecoveryNextStep;
};

export type PairingConnectErrorDetails = {
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

export function readConnectErrorDetailCode(details: unknown): string | null {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return null;
  }
  const code = (details as { code?: unknown }).code;
  return typeof code === "string" && code.trim().length > 0 ? code : null;
}

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
  const normalizedNextStep = normalizeOptionalString(raw.recommendedNextStep) ?? "";
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
  const normalized = normalizeOptionalString(value) ?? "";
  return CONNECT_PAIRING_REQUIRED_REASON_VALUES.has(normalized as ConnectPairingRequiredReason)
    ? (normalized as ConnectPairingRequiredReason)
    : undefined;
}

export function normalizePairingConnectRequestId(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  return normalized && PAIRING_CONNECT_REQUEST_ID_PATTERN.test(normalized) ? normalized : undefined;
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value
    .map((item) => normalizeOptionalString(item))
    .filter((item): item is string => Boolean(item));
  return normalized.length > 0 ? normalized : [];
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

export function describePairingConnectRequirement(
  reason: ConnectPairingRequiredReason | undefined,
): string {
  return reason
    ? PAIRING_CONNECT_REASON_METADATA[reason].requirement
    : "device approval is required";
}

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

export function buildPairingConnectRecoveryTitle(
  reason: ConnectPairingRequiredReason | undefined,
): string {
  return reason
    ? PAIRING_CONNECT_REASON_METADATA[reason].recoveryTitle
    : "Gateway pairing approval required.";
}

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
    normalizeOptionalString(params.remediationHint) ??
    buildPairingConnectRemediationHint(params.reason);
  const deviceId = normalizeOptionalString(params.deviceId);
  const requestedRole = normalizeOptionalString(params.requestedRole);
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

export function buildPairingConnectCloseReason(params: {
  reason: ConnectPairingRequiredReason | undefined;
  requestId?: string;
}): string {
  const requestId = normalizePairingConnectRequestId(params.requestId);
  const message = buildPairingConnectErrorMessage(params.reason);
  return requestId ? `${message} (requestId: ${requestId})` : message;
}

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
    normalizeOptionalString(raw.remediationHint) ?? buildPairingConnectRemediationHint(reason);
  const normalizedNextStep = normalizeOptionalString(raw.recommendedNextStep) ?? "";
  const recommendedNextStep = CONNECT_RECOVERY_NEXT_STEP_VALUES.has(
    normalizedNextStep as ConnectRecoveryNextStep,
  )
    ? (normalizedNextStep as ConnectRecoveryNextStep)
    : undefined;
  const deviceId = normalizeOptionalString(raw.deviceId);
  const requestedRole = normalizeOptionalString(raw.requestedRole);
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

export function readConnectPairingRequiredDetails(
  details: unknown,
): ConnectPairingRequiredDetails | null {
  const pairing = readPairingConnectErrorDetails(details);
  if (!pairing) {
    return null;
  }
  return {
    ...(pairing.requestId ? { requestId: pairing.requestId } : {}),
    ...(pairing.reason ? { reason: pairing.reason } : {}),
  };
}

export function readConnectPairingRequiredMessage(
  message: string | null | undefined,
): ConnectPairingRequiredDetails | null {
  const normalizedMessage = normalizeOptionalString(message);
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

export function formatConnectPairingRequiredMessage(details: unknown): string {
  const pairing = readPairingConnectErrorDetails(details);
  const base =
    CONNECT_PAIRING_REQUIRED_MESSAGE_BY_REASON[
      pairing?.reason ?? ConnectPairingRequiredReasons.NOT_PAIRED
    ];
  return pairing?.requestId ? `${base} (requestId: ${pairing.requestId})` : base;
}

export function formatConnectErrorMessage(params: { message?: string; details?: unknown }): string {
  if (readConnectErrorDetailCode(params.details) === ConnectErrorDetailCodes.PAIRING_REQUIRED) {
    return formatConnectPairingRequiredMessage(params.details);
  }
  if (readConnectErrorDetailCode(params.details) === ConnectErrorDetailCodes.PROTOCOL_MISMATCH) {
    return formatProtocolMismatchMessage(params.message, params.details);
  }
  return normalizeOptionalString(params.message) ?? "gateway request failed";
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
  const normalized = normalizeOptionalString(message) ?? "protocol mismatch";
  return parts.length > 0 ? `${normalized}: ${parts.join(", ")}` : normalized;
}

function normalizeProtocolNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

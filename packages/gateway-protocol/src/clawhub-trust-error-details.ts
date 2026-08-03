/** Structured ClawHub trust details carried in gateway error payloads. */
export const ClawHubTrustErrorCodes = {
  SECURITY_UNAVAILABLE: "clawhub_security_unavailable",
  RISK_ACKNOWLEDGEMENT_REQUIRED: "clawhub_risk_acknowledgement_required",
  DOWNLOAD_BLOCKED: "clawhub_download_blocked",
} as const;

type ClawHubTrustErrorCode = (typeof ClawHubTrustErrorCodes)[keyof typeof ClawHubTrustErrorCodes];

export type ClawHubTrustErrorDetails = {
  clawhubTrustCode?: ClawHubTrustErrorCode;
  version?: string;
  warning?: string;
};

function normalizeNonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function isClawHubTrustErrorCode(value: unknown): value is ClawHubTrustErrorCode {
  return (
    value === ClawHubTrustErrorCodes.SECURITY_UNAVAILABLE ||
    value === ClawHubTrustErrorCodes.RISK_ACKNOWLEDGEMENT_REQUIRED ||
    value === ClawHubTrustErrorCodes.DOWNLOAD_BLOCKED
  );
}

export function buildClawHubTrustErrorDetails(params: {
  code?: ClawHubTrustErrorCode;
  version?: string;
  warning?: string;
}): ClawHubTrustErrorDetails | undefined {
  if (!params.code && !params.version && !params.warning) {
    return undefined;
  }
  return {
    ...(params.code ? { clawhubTrustCode: params.code } : {}),
    ...(params.version ? { version: params.version } : {}),
    ...(params.warning ? { warning: params.warning } : {}),
  };
}

export function readClawHubTrustErrorDetails(
  details: unknown,
): ClawHubTrustErrorDetails | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  const raw = details as {
    clawhubTrustCode?: unknown;
    version?: unknown;
    warning?: unknown;
  };
  const code = isClawHubTrustErrorCode(raw.clawhubTrustCode) ? raw.clawhubTrustCode : undefined;
  const version = normalizeNonEmptyString(raw.version);
  const warning = normalizeNonEmptyString(raw.warning);
  if (!code && !version && !warning) {
    return undefined;
  }
  return {
    ...(code ? { clawhubTrustCode: code } : {}),
    ...(version ? { version } : {}),
    ...(warning ? { warning } : {}),
  };
}

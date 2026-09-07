import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { isProtocolRecord } from "./protocol-value-normalization.js";

/** Structured ClawHub trust details carried in gateway error payloads. */
export const ClawHubTrustErrorCodes = {
  SECURITY_UNAVAILABLE: "clawhub_security_unavailable",
  DOWNLOAD_BLOCKED: "clawhub_download_blocked",
} as const;

type ClawHubTrustErrorCode = (typeof ClawHubTrustErrorCodes)[keyof typeof ClawHubTrustErrorCodes];

export type ClawHubTrustErrorDetails = {
  clawhubTrustCode?: ClawHubTrustErrorCode;
  version?: string;
  warning?: string;
};

export function isClawHubTrustErrorCode(value: unknown): value is ClawHubTrustErrorCode {
  return (
    value === ClawHubTrustErrorCodes.SECURITY_UNAVAILABLE ||
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
  if (!isProtocolRecord(details)) {
    return undefined;
  }
  const code = isClawHubTrustErrorCode(details.clawhubTrustCode)
    ? details.clawhubTrustCode
    : undefined;
  const version = readNonBlankString(details.version);
  const warning = readNonBlankString(details.warning);
  if (!code && !version && !warning) {
    return undefined;
  }
  return {
    ...(code ? { clawhubTrustCode: code } : {}),
    ...(version ? { version } : {}),
    ...(warning ? { warning } : {}),
  };
}

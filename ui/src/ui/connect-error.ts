import {
  ConnectErrorDetailCodes,
  describePairingConnectRequirement,
  formatConnectPairingRequiredMessage,
  readConnectPairingRequiredMessage,
  readPairingConnectErrorDetails,
} from "../../../src/gateway/protocol/connect-error-details.js";
import { resolveGatewayErrorDetailCode } from "./gateway.ts";
import { normalizeLowercaseStringOrEmpty } from "./string-coerce.ts";

type ErrorWithMessageAndDetails = {
  message?: unknown;
  details?: unknown;
};

function normalizeErrorMessage(message: unknown): string {
  if (typeof message === "string") {
    return message;
  }
  if (message instanceof Error && typeof message.message === "string") {
    return message.message;
  }
  return "unknown error";
}

function formatPairingRequiredError(error: ErrorWithMessageAndDetails): string {
  const message = normalizeErrorMessage(error.message);
  const normalizedMessage = normalizeLowercaseStringOrEmpty(message);
  const pairing = readPairingConnectErrorDetails(error.details);
  const pairingMessage = readConnectPairingRequiredMessage(message);
  const pairingReason = pairing?.reason ?? pairingMessage?.reason;
  if (normalizedMessage.startsWith("pairing required:") && pairingReason) {
    return `gateway pairing required: ${describePairingConnectRequirement(pairingReason)}`;
  }
  if (pairingMessage && normalizedMessage !== "pairing required") {
    return message;
  }

  const approvedRoles = pairing?.approvedRoles?.join(", ") ?? "none";
  const requestedRole = pairing?.requestedRole ?? "none";
  const approvedScopes = pairing?.approvedScopes?.join(", ") ?? "none";
  const requestedScopes = pairing?.requestedScopes?.join(", ") ?? "none";
  switch (pairing?.reason) {
    case "scope-upgrade":
      if (pairing.approvedScopes || pairing.requestedScopes) {
        return `device scope upgrade requires approval (approved: ${approvedScopes}; requested: ${requestedScopes})`;
      }
      return formatConnectPairingRequiredMessage(error.details);
    case "role-upgrade":
      if (pairing.approvedRoles || pairing.requestedRole) {
        return `device role upgrade requires approval (approved: ${approvedRoles}; requested: ${requestedRole})`;
      }
      return formatConnectPairingRequiredMessage(error.details);
    case "metadata-upgrade":
      return "device reconnect details changed and require approval";
    default:
      return "gateway pairing required";
  }
}

function formatErrorFromMessageAndDetails(error: ErrorWithMessageAndDetails): string {
  const message = normalizeErrorMessage(error.message);
  const detailCode = resolveGatewayErrorDetailCode(error);

  switch (detailCode) {
    case ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH:
      return "gateway token mismatch";
    case ConnectErrorDetailCodes.AUTH_UNAUTHORIZED:
      return "gateway auth failed";
    case ConnectErrorDetailCodes.AUTH_RATE_LIMITED:
      return "too many failed authentication attempts";
    case ConnectErrorDetailCodes.PAIRING_REQUIRED:
      return formatPairingRequiredError(error);
    case ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED:
      return "device identity required (use HTTPS/localhost or allow insecure auth explicitly)";
    case ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED:
      return "origin not allowed (open the Control UI from the gateway host or allow it in gateway.controlUi.allowedOrigins)";
    case ConnectErrorDetailCodes.AUTH_TOKEN_MISSING:
      return "gateway token missing";
    default:
      break;
  }

  const normalized = normalizeLowercaseStringOrEmpty(message);
  if (
    normalized === "fetch failed" ||
    normalized === "failed to fetch" ||
    normalized === "connect failed"
  ) {
    return "gateway connect failed";
  }
  return message;
}

export function formatConnectError(error: unknown): string {
  if (error && typeof error === "object") {
    return formatErrorFromMessageAndDetails(error as ErrorWithMessageAndDetails);
  }
  return normalizeErrorMessage(error);
}

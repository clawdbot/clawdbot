import {
  ConnectErrorDetailCodes,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  readConnectErrorDetailCode,
} from "@openclaw/gateway-client/browser";

export function enrichProtocolMismatchDetails(
  message: string | undefined,
  details: unknown,
): unknown {
  if (readConnectErrorDetailCode(details) === ConnectErrorDetailCodes.PROTOCOL_MISMATCH) {
    return details;
  }
  if (!message?.toLowerCase().includes("protocol mismatch")) {
    return details;
  }
  return {
    code: ConnectErrorDetailCodes.PROTOCOL_MISMATCH,
    clientMinProtocol: MIN_CLIENT_PROTOCOL_VERSION,
    clientMaxProtocol: PROTOCOL_VERSION,
    ...(details && typeof details === "object" && !Array.isArray(details) ? details : {}),
  };
}

export function resolveGatewayErrorDetailCode(
  error: { details?: unknown } | null | undefined,
): string | null {
  return readConnectErrorDetailCode(error?.details);
}

import {
  ConnectErrorDetailCodes,
  GatewayProtocolRequestError,
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  readConnectErrorDetailCode,
  shouldPauseGatewayReconnect,
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

export function isLegacyGatewayBuildIdSchemaError(
  error: GatewayProtocolRequestError,
  clientBuildId: string | undefined,
): boolean {
  return Boolean(
    clientBuildId && /invalid connect params.*unexpected property.*buildid/iu.test(error.message),
  );
}

/** Token mismatch stays with its bounded retry owner; static failures pause. */
export function isNonRecoverableConnectError(error: { details?: unknown } | undefined): boolean {
  return error
    ? shouldPauseGatewayReconnect({
        details: error.details,
        protocolMismatchIsTerminal: true,
      })
    : false;
}

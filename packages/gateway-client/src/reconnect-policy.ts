import {
  ConnectErrorDetailCodes,
  readConnectErrorDetailCode,
  readPairingConnectErrorDetails,
} from "@openclaw/gateway-protocol/connect-error-details";

const NON_RECOVERABLE_AUTH_ERRORS = new Set<string>([
  ConnectErrorDetailCodes.AUTH_TOKEN_MISSING,
  ConnectErrorDetailCodes.AUTH_BOOTSTRAP_TOKEN_INVALID,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISSING,
  ConnectErrorDetailCodes.AUTH_PASSWORD_MISMATCH,
  ConnectErrorDetailCodes.AUTH_RATE_LIMITED,
  ConnectErrorDetailCodes.AUTH_DEVICE_TOKEN_MISMATCH,
  ConnectErrorDetailCodes.AUTH_SCOPE_MISMATCH,
  ConnectErrorDetailCodes.PAIRING_REQUIRED,
  ConnectErrorDetailCodes.CONTROL_UI_DEVICE_IDENTITY_REQUIRED,
  ConnectErrorDetailCodes.DEVICE_IDENTITY_REQUIRED,
]);

export function shouldPauseGatewayReconnect(params: {
  details?: unknown;
  deviceTokenRetryPending?: boolean;
  tokenMismatchIsTerminal?: boolean;
  protocolMismatchIsTerminal?: boolean;
  clientVersionMismatchIsTerminal?: boolean;
}): boolean {
  const code = readConnectErrorDetailCode(params.details);
  if (!code) {
    return false;
  }
  const pairing = readPairingConnectErrorDetails(params.details);
  if (
    code === ConnectErrorDetailCodes.PAIRING_REQUIRED &&
    (pairing?.pauseReconnect === false || pairing?.recommendedNextStep === "wait_then_retry")
  ) {
    return false;
  }
  if (code === ConnectErrorDetailCodes.AUTH_TOKEN_MISMATCH) {
    return params.tokenMismatchIsTerminal === true && !params.deviceTokenRetryPending;
  }
  return (
    NON_RECOVERABLE_AUTH_ERRORS.has(code) ||
    (params.protocolMismatchIsTerminal === true &&
      code === ConnectErrorDetailCodes.PROTOCOL_MISMATCH) ||
    (params.clientVersionMismatchIsTerminal === true &&
      code === ConnectErrorDetailCodes.CLIENT_VERSION_MISMATCH)
  );
}

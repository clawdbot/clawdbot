import { ConnectErrorDetailCodes } from "../../../../packages/gateway-protocol/src/connect-error-details.js";
import { GatewayRequestError, resolveGatewayErrorDetailCode } from "../gateway.ts";

export function isMissingOperatorReadScopeError(err: unknown): boolean {
  if (!(err instanceof GatewayRequestError)) {
    return false;
  }
  const detailCode = resolveGatewayErrorDetailCode(err);
  // AUTH_UNAUTHORIZED is the current server signal for scope failures in RPC responses.
  // The message-based fallback below catches cases where no detail code is set.
  if (detailCode === ConnectErrorDetailCodes.AUTH_UNAUTHORIZED) {
    return true;
  }
  // RPC scope failures do not yet expose a dedicated structured detail code.
  // Fall back to the current gateway message until the protocol surfaces one.
  return err.message.includes("missing scope: operator.read");
}

export function formatMissingOperatorReadScopeMessage(feature: string): string {
  return `This connection is missing operator.read, so ${feature} cannot be loaded yet.`;
}

// Control UI shared Gateway error helpers.
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { resolveGatewayErrorDetailCode } from "../api/gateway.ts";

export function isMissingOperatorReadScopeError(err: unknown): boolean {
  // Structural check, not instanceof: under isolate:false a custom element
  // registered by an earlier test file keeps its own module registry, so class
  // identity diverges while the error shape (name + details) stays stable.
  if (!(err instanceof Error) || err.name !== "GatewayRequestError") {
    return false;
  }
  const detailCode = resolveGatewayErrorDetailCode(err as { details?: unknown });
  // AUTH_UNAUTHORIZED is the current server signal for scope failures in RPC responses.
  // The message-based branch catches responses that do not include a structured detail code yet.
  return (
    detailCode === ConnectErrorDetailCodes.AUTH_UNAUTHORIZED ||
    err.message.includes("missing scope: operator.read")
  );
}

export function formatMissingOperatorReadScopeMessage(feature: string): string {
  return `This connection is missing operator.read, so ${feature} cannot be loaded yet.`;
}

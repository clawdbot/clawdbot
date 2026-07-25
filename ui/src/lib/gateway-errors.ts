// Control UI shared Gateway error helpers.
import {
  ErrorCodes,
  GatewayErrorDetailCodes,
  readMissingScopeError,
} from "@openclaw/gateway-client/browser";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import { resolveGatewayErrorDetailCode } from "../api/gateway.ts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Identifies an expired process-local wizard session without parsing public copy. */
export function isWizardNotFoundError(err: unknown): boolean {
  const error = asRecord(err);
  if (!error) {
    return false;
  }
  const code =
    typeof error.gatewayCode === "string"
      ? error.gatewayCode
      : typeof error.code === "string"
        ? error.code
        : null;
  return (
    code === ErrorCodes.INVALID_REQUEST &&
    asRecord(error.details)?.code === GatewayErrorDetailCodes.WIZARD_NOT_FOUND
  );
}

export function isMissingOperatorReadScopeError(err: unknown): boolean {
  // Structural check, not instanceof: under isolate:false a custom element
  // registered by an earlier test file keeps its own module registry, so class
  // identity diverges while the error shape (name + details) stays stable.
  if (!(err instanceof Error) || err.name !== "GatewayRequestError") {
    return false;
  }
  if (readMissingScopeError(err)?.missingScope === "operator.read") {
    return true;
  }
  const detailCode = resolveGatewayErrorDetailCode(err as { details?: unknown });
  // Older gateways sometimes reused the connect-time authorization detail for RPC failures.
  return detailCode === ConnectErrorDetailCodes.AUTH_UNAUTHORIZED;
}

export function formatMissingOperatorReadScopeMessage(feature: string): string {
  return `This connection is missing operator.read, so ${feature} cannot be loaded yet.`;
}

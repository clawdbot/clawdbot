import { GatewayProtocolRequestError } from "@openclaw/gateway-client/browser";
import {
  isGatewayRestartUnavailableError,
  isGatewaySuspendUnavailableError,
} from "../../../packages/gateway-protocol/src/restart-unavailable.ts";
import { isRetryableGatewayStartupUnavailableError } from "../../../packages/gateway-protocol/src/startup-unavailable.ts";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";

export function isGatewayUnavailableError(error: unknown): boolean {
  return (
    (error instanceof GatewayProtocolRequestError &&
      (isGatewaySuspendUnavailableError(error) || isGatewayRestartUnavailableError(error))) ||
    isRetryableGatewayStartupUnavailableError(error)
  );
}

export function isGatewayAvailable(
  snapshot: Pick<ApplicationGatewaySnapshot, "phase" | "restartPending" | "suspensionPhase">,
): boolean {
  return (
    snapshot.phase === "connected" &&
    snapshot.restartPending !== true &&
    (snapshot.suspensionPhase === undefined || snapshot.suspensionPhase === "accepting")
  );
}

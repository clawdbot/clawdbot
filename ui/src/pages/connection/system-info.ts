import { GatewayRequestError } from "../../api/gateway.ts";
import type { ApplicationGatewaySnapshot } from "../../app/context.ts";

export function isUnknownSystemInfoMethodError(error: unknown): boolean {
  return (
    error instanceof GatewayRequestError &&
    error.gatewayCode === "INVALID_REQUEST" &&
    error.message.includes("unknown method: system.info")
  );
}

export function supportsSystemInfo(hello: ApplicationGatewaySnapshot["hello"]): boolean {
  return hello?.features?.methods?.includes("system.info") === true;
}

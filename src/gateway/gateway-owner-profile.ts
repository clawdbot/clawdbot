import type { GatewayAuthResult } from "./auth.js";

/** Owner attribution never supplies a verified login or changes operator authority. */
export function shouldUseGatewayOwnerProfile(params: {
  role: string;
  authenticatedUserId?: string;
  authMethod: GatewayAuthResult["method"];
  rolesConfigured: boolean;
}): boolean {
  return (
    params.role === "operator" &&
    !params.authenticatedUserId &&
    (!params.rolesConfigured || params.authMethod === "token" || params.authMethod === "password")
  );
}

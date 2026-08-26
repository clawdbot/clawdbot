import { gatewayCredentialScope } from "../../packages/gateway-client/src/gateway-origin-scope.js";

/** Returns whether an explicit remote Gateway URL selects a different endpoint. */
export function remoteGatewayUrlChanged(
  nextUrl: string | undefined,
  previousUrl: string | undefined,
): boolean {
  return (
    nextUrl !== undefined &&
    gatewayCredentialScope(nextUrl) !== gatewayCredentialScope(previousUrl ?? "")
  );
}

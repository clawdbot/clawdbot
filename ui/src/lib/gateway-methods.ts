import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import type { ApplicationGatewaySnapshot } from "../app/gateway.ts";

export type GatewayMethodOperatorScope = "operator.read" | "operator.write" | "operator.admin";

export function isGatewayMethodAdvertised(
  host: {
    hello?: {
      features?: { methods?: string[] } | null;
    } | null;
  },
  method: string,
): boolean | null {
  const methods = host.hello?.features?.methods;
  if (!Array.isArray(methods)) {
    return null;
  }
  return methods.includes(method);
}

export function isGatewayCapabilityAdvertised(
  host: {
    hello?: {
      features?: { capabilities?: string[] } | null;
    } | null;
  },
  capability: string,
): boolean | null {
  const capabilities = host.hello?.features?.capabilities;
  if (!Array.isArray(capabilities)) {
    return null;
  }
  return capabilities.includes(capability);
}

/**
 * Combines the active connection, advertised method catalog, and operator
 * scopes. Older Gateways may omit either metadata surface, so only explicit
 * method absence or an explicit insufficient scope blocks the action.
 */
export function canCallGatewayMethod(
  snapshot: Pick<ApplicationGatewaySnapshot, "client" | "hello" | "phase"> | null | undefined,
  method: string,
  requiredScope: GatewayMethodOperatorScope,
  options: { requireAdvertisement?: boolean } = {},
): boolean {
  if (!snapshot?.client || snapshot.phase !== "connected") {
    return false;
  }
  if (
    options.requireAdvertisement !== false &&
    isGatewayMethodAdvertised(snapshot, method) === false
  ) {
    return false;
  }
  const auth = snapshot.hello?.auth ?? null;
  return (
    !auth?.scopes ||
    roleScopesAllow({
      role: auth.role ?? "operator",
      requestedScopes: [requiredScope],
      allowedScopes: auth.scopes,
    })
  );
}

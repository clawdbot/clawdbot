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

export function supportsSessionUnreadAckContract(
  host: Parameters<typeof isGatewayCapabilityAdvertised>[0],
): boolean {
  return isGatewayCapabilityAdvertised(host, "session-unread-ack-contract") === true;
}

/** Combines the active connection, advertised method catalog, and operator scopes. */
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
    isGatewayMethodAdvertised(snapshot, method) !== true
  ) {
    return false;
  }
  const auth = snapshot.hello?.auth;
  if (!auth || !Array.isArray(auth.scopes)) {
    return false;
  }
  return roleScopesAllow({
    role: auth.role,
    requestedScopes: [requiredScope],
    allowedScopes: auth.scopes,
  });
}

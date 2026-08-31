// Gateway connection role policy.
// Separates node-role RPCs from operator RPCs before method scope checks.
import { isNodeRoleMethod } from "./method-scopes.js";

const GATEWAY_ROLES = ["operator", "node"] as const;

/** Gateway connection roles used before method-level operator scope checks. */
export type GatewayRole = (typeof GATEWAY_ROLES)[number];

/** Parses the untrusted role claim from connect params into the closed role set. */
export function parseGatewayRole(roleRaw: unknown): GatewayRole | null {
  if (roleRaw === "operator" || roleRaw === "node") {
    return roleRaw;
  }
  return null;
}

/** Operators using shared auth may connect before device identity is established. */
export function roleCanSkipDeviceIdentity(role: GatewayRole, sharedAuthOk: boolean): boolean {
  return role === "operator" && sharedAuthOk;
}

/** Keeps node-originated notifications off the operator RPC surface, and vice versa. */
export function isRoleAuthorizedForMethod(role: GatewayRole, method: string): boolean {
  if (isNodeRoleMethod(method)) {
    return role === "node";
  }
  return role === "operator";
}

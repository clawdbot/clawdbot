// Control UI app-level operator scope checks.
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";

export function hasOperatorWriteAccess(
  auth: { role?: string; scopes?: readonly string[] } | null,
): boolean {
  if (!auth?.scopes) {
    return true;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: ["operator.write"],
    allowedScopes: auth.scopes,
  });
}

export function hasOperatorAdminAccess(
  auth: { role?: string; scopes?: readonly string[] } | null,
): boolean {
  if (!auth?.scopes) {
    return true;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: ["operator.admin"],
    allowedScopes: auth.scopes,
  });
}

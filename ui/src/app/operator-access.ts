// Control UI app-level operator scope checks.
import { roleScopesAllow } from "../../../src/shared/operator-scope-compat.js";
import type { ApplicationGatewaySnapshot } from "./gateway.ts";

type GatewayOperatorAccess = Readonly<{
  canWrite: boolean;
  canAdmin: boolean;
  canPair: boolean;
  canReviewApprovals: boolean;
  canGrantApprovals: boolean;
}>;

export function readGatewayOperatorAccess(
  snapshot: Pick<ApplicationGatewaySnapshot, "hello"> | null | undefined,
): GatewayOperatorAccess {
  const auth = snapshot?.hello?.auth ?? null;
  return {
    canWrite: hasOperatorWriteAccess(auth),
    canAdmin: hasOperatorAdminAccess(auth),
    canPair: hasOperatorPairingAccess(auth),
    // Older Gateways did not advertise auth, but must retain approval review.
    canReviewApprovals: !auth || hasOperatorApprovalsAccess(auth),
    // Grants require an authenticated approval owner even on legacy snapshots.
    canGrantApprovals: hasOperatorApprovalsAccess(auth),
  };
}

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

export function hasOperatorPairingAccess(
  auth: { role?: string; scopes?: readonly string[] } | null,
): boolean {
  if (!auth) {
    return false;
  }
  if (!auth.scopes) {
    return true;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: ["operator.pairing"],
    allowedScopes: auth.scopes,
  });
}

export function hasOperatorApprovalsAccess(
  auth: { role?: string; scopes?: readonly string[] } | null,
): boolean {
  if (!auth) {
    return false;
  }
  if (!auth.scopes) {
    return true;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: ["operator.approvals"],
    allowedScopes: auth.scopes,
  });
}

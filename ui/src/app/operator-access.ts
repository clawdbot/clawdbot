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

type OperatorAuth = { role?: string; scopes?: readonly string[] } | null;
type OperatorScope =
  | "operator.read"
  | "operator.write"
  | "operator.admin"
  | "operator.pairing"
  | "operator.approvals";

function hasOperatorScope(
  auth: OperatorAuth,
  requestedScope: OperatorScope,
  missingAuthHasAccess: boolean,
): boolean {
  if (!auth) {
    return missingAuthHasAccess;
  }
  if (!auth.scopes) {
    return true;
  }
  return roleScopesAllow({
    role: auth.role ?? "operator",
    requestedScopes: [requestedScope],
    allowedScopes: auth.scopes,
  });
}

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

export function hasOperatorWriteAccess(auth: OperatorAuth): boolean {
  return hasOperatorScope(auth, "operator.write", true);
}

export function hasOperatorReadAccess(auth: OperatorAuth): boolean {
  return hasOperatorScope(auth, "operator.read", true);
}

export function hasOperatorAdminAccess(auth: OperatorAuth): boolean {
  return hasOperatorScope(auth, "operator.admin", true);
}

export function hasOperatorPairingAccess(auth: OperatorAuth): boolean {
  return hasOperatorScope(auth, "operator.pairing", false);
}

export function hasOperatorApprovalsAccess(auth: OperatorAuth): boolean {
  return hasOperatorScope(auth, "operator.approvals", false);
}

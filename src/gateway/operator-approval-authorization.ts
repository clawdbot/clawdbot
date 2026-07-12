import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "./method-scopes.js";
import type { GatewayClient } from "./server-methods/types.js";

export type OperatorApprovalAccessBinding = {
  reviewerDeviceIds?: readonly string[] | null;
};

function normalizeIdentity(value: string | null | undefined): string | null {
  return normalizeOptionalString(value) ?? null;
}

function normalizeIdentities(values: readonly string[] | null | undefined): string[] {
  const normalized = new Set<string>();
  for (const value of values ?? []) {
    const identity = normalizeIdentity(value);
    if (identity) {
      normalized.add(identity);
    }
  }
  return [...normalized];
}

/** Whether a client may inspect safe approval projections. */
export function canReviewOperatorApproval(client: GatewayClient | null): boolean {
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  if (!scopes.includes(APPROVALS_SCOPE)) {
    return false;
  }
  return Boolean(normalizeOptionalString(client?.connect?.device?.id));
}

/** Whether a client may submit an approval verdict. */
export function canResolveOperatorApproval(client: GatewayClient | null): boolean {
  // approvalRuntime is server-authenticated connection metadata. Public request
  // fields cannot mint this device-less resolver authority.
  const scopes = Array.isArray(client?.connect?.scopes) ? client.connect.scopes : [];
  const isTrustedApprovalRuntime =
    client?.internal?.approvalRuntime === true && scopes.includes(APPROVALS_SCOPE);
  return isTrustedApprovalRuntime || canReviewOperatorApproval(client);
}

/** Whether a broadly authorized client may access one bound approval record. */
export function canAccessOperatorApproval(params: {
  client: GatewayClient | null;
  binding: OperatorApprovalAccessBinding;
  allowApprovalRuntime?: boolean;
}): boolean {
  const broadlyAuthorized = params.allowApprovalRuntime
    ? canResolveOperatorApproval(params.client)
    : canReviewOperatorApproval(params.client);
  if (!broadlyAuthorized) {
    return false;
  }

  const scopes = Array.isArray(params.client?.connect?.scopes) ? params.client.connect.scopes : [];
  if (scopes.includes(ADMIN_SCOPE)) {
    return true;
  }
  if (params.allowApprovalRuntime && params.client?.internal?.approvalRuntime === true) {
    return true;
  }

  const clientDeviceId = normalizeIdentity(params.client?.connect?.device?.id);
  const reviewerDeviceIds = normalizeIdentities(params.binding.reviewerDeviceIds);
  if (reviewerDeviceIds.length > 0) {
    return Boolean(clientDeviceId && reviewerDeviceIds.includes(clientDeviceId));
  }

  // No explicit reviewer binding: the operator.approvals scope tier is the
  // access authority, matching the shipped contract where any authorized
  // approval surface (Telegram buttons, macOS app, control UI) may resolve
  // any pending approval. Cross-surface first-answer-wins depends on this;
  // reviewerDeviceIds is the opt-in restriction, and requester identity gates
  // only the legacy adapters in approval-shared.
  return true;
}

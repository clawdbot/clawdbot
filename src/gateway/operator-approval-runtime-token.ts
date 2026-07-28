// Operator approval runtime token.
// Uses an existing shared socket token when available, with a process-local fallback.
import { createHmac, randomBytes } from "node:crypto";
import { loadExecApprovals } from "../infra/exec-approvals.js";
import { safeEqualSecret } from "../security/secret-equal.js";

const APPROVAL_RUNTIME_TOKEN_CONTEXT = "openclaw:gateway-approval-runtime-token:v1";

let fallbackApprovalRuntimeToken: string | null = null;

function deriveApprovalRuntimeToken(socketToken: string): string {
  return createHmac("sha256", socketToken)
    .update(APPROVAL_RUNTIME_TOKEN_CONTEXT)
    .digest("base64url");
}

function readSharedApprovalRuntimeToken(): string | null {
  const token = loadExecApprovals().socket?.token?.trim();
  return token ? deriveApprovalRuntimeToken(token) : null;
}

/**
 * Returns the token used to authorize local operator-approval clients.
 */
export function getOperatorApprovalRuntimeToken(): string {
  const sharedToken = readSharedApprovalRuntimeToken();
  if (sharedToken) {
    return sharedToken;
  }
  fallbackApprovalRuntimeToken ??= randomBytes(32).toString("base64url");
  return fallbackApprovalRuntimeToken;
}

/**
 * Validates a presented loopback approval token without accepting empty or partial matches.
 */
export function isOperatorApprovalRuntimeToken(value: string | null | undefined): boolean {
  const token = value?.trim();
  if (!token) {
    return false;
  }
  const sharedToken = readSharedApprovalRuntimeToken();
  if (safeEqualSecret(token, sharedToken)) {
    return true;
  }
  const fallbackToken =
    fallbackApprovalRuntimeToken ?? (sharedToken ? null : getOperatorApprovalRuntimeToken());
  return safeEqualSecret(token, fallbackToken);
}

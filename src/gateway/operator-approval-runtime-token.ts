// Operator approval runtime token.
// Provides a process-local loopback token for approval helper clients.
import { randomBytes, timingSafeEqual } from "node:crypto";

let approvalRuntimeToken: string | null = null;

/**
 * Returns the process-local token used to authorize loopback operator-approval clients.
 */
export function getOperatorApprovalRuntimeToken(): string {
  approvalRuntimeToken ??= randomBytes(32).toString("base64url");
  return approvalRuntimeToken;
}

/**
 * Validates a presented loopback approval token without accepting empty or partial matches.
 */
export function isOperatorApprovalRuntimeToken(value: string | null | undefined): boolean {
  const token = value?.trim();
  if (!token) {
    return false;
  }
  const expected = getOperatorApprovalRuntimeToken();
  const tokenBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  // timingSafeEqual requires equal lengths; keep length rejection explicit instead of catching.
  return tokenBytes.length === expectedBytes.length && timingSafeEqual(tokenBytes, expectedBytes);
}

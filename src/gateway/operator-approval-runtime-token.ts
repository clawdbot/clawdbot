import { randomBytes, timingSafeEqual } from "node:crypto";

let approvalRuntimeToken: string | null = null;

export function getOperatorApprovalRuntimeToken(): string {
  approvalRuntimeToken ??= randomBytes(32).toString("base64url");
  return approvalRuntimeToken;
}

export function isOperatorApprovalRuntimeToken(value: string | null | undefined): boolean {
  const token = value?.trim();
  if (!token) {
    return false;
  }
  const expected = getOperatorApprovalRuntimeToken();
  const tokenBytes = Buffer.from(token);
  const expectedBytes = Buffer.from(expected);
  return tokenBytes.length === expectedBytes.length && timingSafeEqual(tokenBytes, expectedBytes);
}

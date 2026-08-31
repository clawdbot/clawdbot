// Approval resolution references compact exact IDs for transport-private callbacks.
import { createHash } from "node:crypto";

const APPROVAL_RESOLUTION_REF_LENGTH = 43;

/** Build the full SHA-256 base64url locator used only when a transport cannot carry the exact id. */
export function buildApprovalResolutionRef(params: {
  approvalId: string;
  approvalKind: "exec" | "plugin" | "system-agent";
  instanceId?: string;
}): string {
  const hash = createHash("sha256")
    .update(params.approvalKind, "utf8")
    .update("\0", "utf8")
    .update(params.approvalId, "utf8");
  if (params.instanceId) {
    hash.update("\0", "utf8").update(params.instanceId, "utf8");
  }
  return hash.digest("base64url");
}

export function isApprovalResolutionRef(value: string): boolean {
  return value.length === APPROVAL_RESOLUTION_REF_LENGTH && /^[A-Za-z0-9_-]+$/u.test(value);
}

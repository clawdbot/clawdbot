import { normalizeBasePath } from "../app-route-paths.ts";

export type ApprovalDocumentMode = {
  kind: "approval";
  approvalId: string | null;
};

/**
 * Recognizes the shellless approval document before the exact-path app router
 * can replace it with Chat. The Gateway validates the decoded id; this parser
 * only preserves the one-segment URL contract and rejects ambiguous paths.
 */
export function resolveApprovalDocumentMode(
  pathname: string,
  basePath: string,
): ApprovalDocumentMode | null {
  const normalizedBasePath = normalizeBasePath(basePath);
  const approvalRoot = `${normalizedBasePath}/approve`;
  if (pathname === approvalRoot || pathname === `${approvalRoot}/`) {
    return { kind: "approval", approvalId: null };
  }
  const prefix = `${approvalRoot}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const encodedId = pathname.slice(prefix.length);
  if (!encodedId || encodedId.includes("/")) {
    return { kind: "approval", approvalId: null };
  }
  try {
    const approvalId = decodeURIComponent(encodedId);
    return approvalId && approvalId !== "." && approvalId !== ".."
      ? { kind: "approval", approvalId }
      : { kind: "approval", approvalId: null };
  } catch {
    return { kind: "approval", approvalId: null };
  }
}

export * from "../infra/errors.js";

export function isApprovalNotFoundError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  const candidate = err as {
    gatewayCode?: unknown;
    details?: { reason?: unknown };
    message?: unknown;
    code?: unknown;
  };
  if (
    candidate.gatewayCode === "INVALID_REQUEST" &&
    candidate.details?.reason === "APPROVAL_NOT_FOUND"
  ) {
    return true;
  }
  if (candidate.code === "APPROVAL_NOT_FOUND") {
    return true;
  }
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : "";
  return (
    message.includes("approval not found") ||
    message.includes("unknown or expired approval id") ||
    message.includes("unknown approval id")
  );
}

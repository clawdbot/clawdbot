import {
  isTelegramEditTargetMissingError,
  isTelegramMessageHasNoTextError,
} from "./network-errors.js";

export class TelegramRetryableCallbackError extends Error {
  public override readonly cause: unknown;

  constructor(cause: unknown) {
    super(String(cause));
    this.cause = cause;
    this.name = "TelegramRetryableCallbackError";
  }
}

export const isPermanentTelegramCallbackEditError = (err: unknown): boolean =>
  isTelegramEditTargetMissingError(err) || isTelegramMessageHasNoTextError(err);

export function isApprovalAlreadyResolvedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  const record = error as {
    gatewayCode?: unknown;
    details?: { reason?: unknown } | null;
  };
  const reason = record.details?.reason;
  return (
    record.gatewayCode === "APPROVAL_ALREADY_RESOLVED" ||
    (record.gatewayCode === "INVALID_REQUEST" && reason === "APPROVAL_ALREADY_RESOLVED") ||
    /approval already resolved/i.test(error.message)
  );
}

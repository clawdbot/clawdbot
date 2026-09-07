// Matrix plugin module implements errors behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

export function formatMatrixErrorReason(err: unknown): string {
  return normalizeLowercaseStringOrEmpty(formatErrorMessage(err));
}

export function isMatrixNotFoundError(err: unknown): boolean {
  const errObj = err as { statusCode?: number; body?: { errcode?: string } };
  if (errObj?.statusCode === 404 || errObj?.body?.errcode === "M_NOT_FOUND") {
    return true;
  }
  const message = formatMatrixErrorReason(err);
  return (
    message.includes("m_not_found") || message.includes("[404]") || message.includes("not found")
  );
}

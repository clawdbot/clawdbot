import type { JsonValue } from "./protocol.js";

/** RPC error wrapper that preserves app-server error code and data. */
export class CodexAppServerRpcError extends Error {
  readonly code?: number;
  readonly data?: JsonValue;
  readonly method: string;

  constructor(error: { code?: number; message: string; data?: JsonValue }, method: string) {
    super(formatCodexAppServerRpcErrorMessage(error, method));
    this.name = "CodexAppServerRpcError";
    this.code = error.code;
    this.data = error.data;
    this.method = method;
  }
}

function formatCodexAppServerRpcErrorMessage(
  error: { message: string; data?: JsonValue },
  method: string,
): string {
  const message = error.message || `${method} failed`;
  const detail = readCodexAppServerRpcReloginDetail(error.data);
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
}

function readCodexAppServerRpcReloginDetail(data: JsonValue | undefined): string | undefined {
  const record = isJsonObject(data) ? data : undefined;
  const nested = isJsonObject(record?.error) ? record.error : record;
  if (!nested) {
    return undefined;
  }
  const isRelogin =
    nested.action === "relogin" ||
    (nested.reason === "cloudRequirements" && nested.errorCode === "Auth");
  const detail = typeof nested.detail === "string" ? nested.detail.trim() : "";
  return isRelogin && detail ? detail : undefined;
}

function isJsonObject(value: unknown): value is { [key: string]: JsonValue } {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

import { createHash } from "node:crypto";
import { normalizeOptionalString } from "./string-coerce.js";

export function sha256Hex(input: string | Uint8Array): string {
  return createHash("sha256").update(input).digest("hex");
}

export function sha256HexPrefixCore(input: string | Uint8Array, length: number): string {
  return sha256Hex(input).slice(0, length);
}

/** Redacts an identifier to a stable hash label, or "-" for missing values. */
export function redactIdentifier(value: string | undefined, opts?: { len?: number }): string {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return "-";
  }
  const len = opts?.len ?? 12;
  const safeLen = Number.isFinite(len) ? Math.max(1, Math.floor(len)) : 12;
  return `sha256:${sha256HexPrefixCore(trimmed, safeLen)}`;
}

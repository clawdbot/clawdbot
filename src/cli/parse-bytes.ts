import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../shared/string-coerce.js";

type BytesParseOptions = {
  defaultUnit?: "b" | "kb" | "mb" | "gb" | "tb";
};

const UNIT_MULTIPLIERS: Record<string, number> = {
  b: 1,
  kb: 1024,
  k: 1024,
  mb: 1024 ** 2,
  m: 1024 ** 2,
  gb: 1024 ** 3,
  g: 1024 ** 3,
  tb: 1024 ** 4,
  t: 1024 ** 4,
};

function invalidByteSize(raw: string, reason?: string): Error {
  const value = raw.trim() ? `"${raw}"` : "empty value";
  const prefix = reason
    ? `Invalid byte size (${reason}): ${value}.`
    : `Invalid byte size: ${value}.`;
  return new Error(`${prefix} Use values like 512kb, 10mb, 1gb, or 500.`);
}

export function parseByteSize(raw: string, opts?: BytesParseOptions): number {
  const trimmed = normalizeLowercaseStringOrEmpty(normalizeOptionalString(raw) ?? "");
  if (!trimmed) {
    throw invalidByteSize(raw, "empty");
  }

  const m = /^(\d+(?:\.\d+)?)([a-z]+)?$/.exec(trimmed);
  if (!m) {
    throw invalidByteSize(raw);
  }

  const value = Number(m[1]);
  if (!Number.isFinite(value) || value < 0) {
    throw invalidByteSize(raw);
  }

  const unit = normalizeLowercaseStringOrEmpty(m[2] ?? opts?.defaultUnit ?? "b");
  const multiplier = UNIT_MULTIPLIERS[unit];
  if (!multiplier) {
    throw invalidByteSize(raw, `unknown unit "${unit}"`);
  }

  const bytes = Math.round(value * multiplier);
  if (!Number.isFinite(bytes)) {
    throw invalidByteSize(raw);
  }
  return bytes;
}

import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

export function parseCronThreadIdOption(value: unknown): number | undefined {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return undefined;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error("--thread-id must be a positive integer Telegram topic thread id");
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error("--thread-id must be a safe positive integer Telegram topic thread id");
  }
  return parsed;
}

export function normalizeCronSessionTargetOption(value: unknown): string | undefined {
  const raw = normalizeOptionalString(value);
  if (!raw) {
    return undefined;
  }
  const lower = normalizeLowercaseStringOrEmpty(raw);
  if (lower === "main" || lower === "isolated" || lower === "current") {
    return lower;
  }
  if (lower.startsWith("session:")) {
    const id = normalizeOptionalString(raw.slice(8));
    return id ? `session:${id}` : undefined;
  }
  return undefined;
}

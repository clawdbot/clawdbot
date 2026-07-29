// Defines allowed-value metadata for config validation and docs.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";

const MAX_ALLOWED_VALUES_HINT = 12;
const MAX_ALLOWED_VALUE_CHARS = 160;

type AllowedValuesSummary = {
  values: string[];
  hiddenCount: number;
  formatted: string;
};

function truncateHintText(text: string, limit: number): string {
  if (text.length <= limit) {
    return text;
  }
  const truncated = truncateUtf16Safe(text, limit);
  return `${truncated}... (+${text.length - truncated.length} chars)`;
}

function safeStringify(value: unknown): string {
  if (value === undefined) {
    return "";
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) {
      return serialized;
    }
  } catch {
    // Fall back to string coercion when value is not JSON-serializable.
  }
  // This is the deliberate last-resort renderer; the assertion opts into
  // String() semantics for non-JSON values without changing runtime behavior.
  return String(value as string | number | boolean | bigint | symbol | null);
}

function toAllowedValueLabel(value: unknown): string {
  if (typeof value === "string") {
    return JSON.stringify(truncateHintText(value, MAX_ALLOWED_VALUE_CHARS));
  }
  return truncateHintText(safeStringify(value), MAX_ALLOWED_VALUE_CHARS);
}

function toAllowedValueValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  return safeStringify(value);
}

function toAllowedValueDedupKey(value: unknown): string {
  if (value === null) {
    return "null:null";
  }
  const kind = typeof value;
  // Preserve schema distinctions such as numeric 1 vs string "1" even when labels match.
  if (kind === "string") {
    return `string:${value as string}`;
  }
  return `${kind}:${safeStringify(value)}`;
}

/** Summarizes enum/allowed-value candidates for compact validation error hints. */
export function summarizeAllowedValues(
  values: ReadonlyArray<unknown>,
): AllowedValuesSummary | null {
  if (values.length === 0) {
    return null;
  }

  const deduped: Array<{ value: string; label: string }> = [];
  const seenValues = new Set<string>();
  for (const item of values) {
    const dedupeKey = toAllowedValueDedupKey(item);
    if (seenValues.has(dedupeKey)) {
      continue;
    }
    seenValues.add(dedupeKey);
    deduped.push({
      value: toAllowedValueValue(item),
      label: toAllowedValueLabel(item),
    });
  }

  const shown = deduped.slice(0, MAX_ALLOWED_VALUES_HINT);
  const hiddenCount = deduped.length - shown.length;
  const formattedCore = shown.map((entry) => entry.label).join(", ");
  const formatted =
    hiddenCount > 0 ? `${formattedCore}, ... (+${hiddenCount} more)` : formattedCore;

  return {
    values: shown.map((entry) => entry.value),
    hiddenCount,
    formatted,
  };
}

function messageAlreadyIncludesAllowedValues(message: string): boolean {
  const lower = normalizeLowercaseStringOrEmpty(message);
  return lower.includes("(allowed:") || lower.includes("expected one of");
}

/** Appends an allowed-values hint unless the validation message already includes one. */
export function appendAllowedValuesHint(message: string, summary: AllowedValuesSummary): string {
  if (messageAlreadyIncludesAllowedValues(message)) {
    return message;
  }
  return `${message} (allowed: ${summary.formatted})`;
}

/**
 * Stable stringify helper.
 * Serializes arbitrary values with deterministic key ordering and explicit
 * handling for errors, binary data, bigint, non-finite numbers, and cycles.
 */
import { Buffer } from "node:buffer";

type StableStringNormalizer = (value: string) => string;

const preserveString = (value: string) => value;

/** Deterministically stringifies values, optionally normalizing strings before key ordering. */
export function stableStringify(
  value: unknown,
  normalizeString: StableStringNormalizer = preserveString,
): string {
  return stringifyStableValue(value, new WeakSet(), normalizeString);
}

function stringifyStableValue(
  value: unknown,
  stack: WeakSet<object>,
  normalizeString: StableStringNormalizer,
): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return JSON.stringify(String(value));
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (typeof value === "string") {
    return JSON.stringify(normalizeString(value));
  }
  if (typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (stack.has(value)) {
    return JSON.stringify("[Circular]");
  }

  stack.add(value);
  try {
    return stringifyObjectValue(value, stack, normalizeString);
  } finally {
    stack.delete(value);
  }
}

function stringifyObjectValue(
  value: object,
  stack: WeakSet<object>,
  normalizeString: StableStringNormalizer,
): string {
  if (value instanceof Error) {
    return stringifyStableValue(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      stack,
      normalizeString,
    );
  }
  if (value instanceof Uint8Array) {
    return stringifyStableValue(
      {
        type: "Uint8Array",
        data: Buffer.from(value).toString("base64"),
      },
      stack,
      normalizeString,
    );
  }
  if (Array.isArray(value)) {
    const serializedEntries: string[] = [];
    for (const entry of value) {
      serializedEntries.push(stringifyStableValue(entry, stack, normalizeString));
    }
    return `[${serializedEntries.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .map((key) => ({ key, normalizedKey: normalizeString(key) }))
    .toSorted((left, right) => {
      const normalizedOrder = compareStableStrings(left.normalizedKey, right.normalizedKey);
      // Distinct source keys can normalize alike; preserve deterministic ordering without loss.
      return normalizedOrder || compareStableStrings(left.key, right.key);
    });
  const serializedFields: string[] = [];
  for (const { key, normalizedKey } of entries) {
    serializedFields.push(
      `${JSON.stringify(normalizedKey)}:${stringifyStableValue(record[key], stack, normalizeString)}`,
    );
  }
  return `{${serializedFields.join(",")}}`;
}

function compareStableStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

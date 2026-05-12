import { Buffer } from "node:buffer";

export function stableStringify(value: unknown): string {
  return stringifyStableValue(value, new WeakSet());
}

function stringifyStableValue(value: unknown, stack: WeakSet<object>): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    return JSON.stringify(String(value));
  }
  if (typeof value === "bigint") {
    return JSON.stringify(value.toString());
  }
  if (typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (stack.has(value)) {
    return JSON.stringify("[Circular]");
  }

  stack.add(value);
  try {
    return stringifyObjectValue(value, stack);
  } finally {
    stack.delete(value);
  }
}

function stringifyObjectValue(value: object, stack: WeakSet<object>): string {
  if (value instanceof Error) {
    return stringifyStableValue(
      {
        name: value.name,
        message: value.message,
        stack: value.stack,
      },
      stack,
    );
  }
  if (value instanceof Uint8Array) {
    return stringifyStableValue(
      {
        type: "Uint8Array",
        data: Buffer.from(value).toString("base64"),
      },
      stack,
    );
  }
  if (Array.isArray(value)) {
    const serializedEntries: string[] = [];
    for (const entry of value) {
      serializedEntries.push(stringifyStableValue(entry, stack));
    }
    return `[${serializedEntries.join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const serializedFields: string[] = [];
  for (const key of Object.keys(record).toSorted()) {
    serializedFields.push(`${JSON.stringify(key)}:${stringifyStableValue(record[key], stack)}`);
  }
  return `{${serializedFields.join(",")}}`;
}

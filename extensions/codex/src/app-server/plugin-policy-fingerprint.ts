import crypto from "node:crypto";
import type { JsonValue } from "./protocol.js";

/** Hashes a policy-shaped JSON value with order-independent serialization. */
export function fingerprintCodexPluginPolicy(value: JsonValue): string {
  return crypto.createHash("sha256").update(stringifyCodexPluginPolicy(value)).digest("hex");
}

export function stringifyCodexPluginPolicy(value: unknown): string {
  // Fingerprints must be process-stable across object insertion order so prompt
  // cache and thread-binding comparisons do not churn between runs.
  if (Array.isArray(value)) {
    return `[${value.map((item) => stringifyCodexPluginPolicy(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stringifyCodexPluginPolicy(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

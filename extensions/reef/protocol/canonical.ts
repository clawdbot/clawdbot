import { sha256 } from "@noble/hashes/sha2.js";
import { hex, utf8 } from "./encoding.js";

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("canonical JSON requires finite numbers");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError("unsupported canonical JSON value");
}

export function canonicalBytes(value: unknown): Uint8Array {
  return utf8(canonicalJson(value));
}

export function sha256Hex(value: Uint8Array): string {
  return hex(sha256(value));
}

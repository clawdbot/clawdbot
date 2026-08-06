// Shared policy doctor value readers.
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";

export function readPolicyStringArray(
  policy: unknown,
  path: readonly string[],
  options: { readonly lowercase?: boolean } = {},
): readonly string[] | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  if (!Array.isArray(current) || !current.every((entry) => typeof entry === "string")) {
    return undefined;
  }
  const lowercase = options.lowercase ?? true;
  return current
    .map((entry) => {
      const trimmed = entry.trim();
      return lowercase ? trimmed.toLowerCase() : trimmed;
    })
    .filter(Boolean);
}

export function readStringList(
  policy: unknown,
  path: readonly string[],
  options?: { readonly lowercase?: boolean },
): readonly string[] {
  return readPolicyStringArray(policy, path, options) ?? [];
}

export function readString(policy: unknown, path: readonly string[]): string | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "string" ? current.trim().toLowerCase() : undefined;
}

export function ocPathSegment(value: string): string {
  if (/^(?:[A-Za-z0-9_-]+|#\d+)$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export function readPolicyBoolean(policy: unknown, path: readonly string[]): boolean | undefined {
  let current: unknown = policy;
  for (const part of path) {
    if (!isRecord(current)) {
      return undefined;
    }
    current = current[part];
  }
  return typeof current === "boolean" ? current : undefined;
}

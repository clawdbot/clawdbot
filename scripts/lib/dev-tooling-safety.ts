import path from "node:path";
import { redactSensitiveText } from "../../src/logging/redact.js";

const REDACT_OPTIONS = { mode: "tools" } as const;

export function redactForDevToolLog(value: string): string {
  return redactSensitiveText(value, REDACT_OPTIONS);
}

export function previewForDevToolLog(value: string, maxChars = 400): string {
  const redacted = redactForDevToolLog(value).replace(/\s+/g, " ").trim();
  if (redacted.length <= maxChars) {
    return redacted;
  }
  return `${redacted.slice(0, Math.max(0, maxChars - 3))}...`;
}

export function maskIdentifier(value: string | undefined, keepStart = 6, keepEnd = 4): string {
  const compact = value?.trim() ?? "";
  if (!compact) {
    return "missing";
  }
  if (compact.length <= keepStart + keepEnd + 3) {
    return "***";
  }
  return `${compact.slice(0, keepStart)}...${compact.slice(-keepEnd)}`;
}

export function redactHomePath(value: string, home = process.env.HOME ?? ""): string {
  const normalizedHome = home ? path.resolve(home) : "";
  if (!normalizedHome) {
    return value;
  }
  const resolved = path.resolve(value);
  if (resolved === normalizedHome) {
    return "~";
  }
  if (resolved.startsWith(`${normalizedHome}${path.sep}`)) {
    return `~${resolved.slice(normalizedHome.length)}`;
  }
  return value;
}

export function parseStrictIntegerOption(params: {
  fallback: number;
  label: string;
  min: number;
  raw: string | undefined;
}): number {
  const raw = params.raw?.trim();
  if (!raw) {
    return params.fallback;
  }
  if (!/^\d+$/u.test(raw)) {
    throw new Error(
      `${params.label} must be an integer >= ${params.min}; got ${JSON.stringify(raw)}`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < params.min) {
    throw new Error(
      `${params.label} must be an integer >= ${params.min}; got ${JSON.stringify(raw)}`,
    );
  }
  return value;
}

export function parseBooleanEnv(params: {
  fallback: boolean;
  name: string;
  raw: string | undefined;
}): boolean {
  const raw = params.raw?.trim().toLowerCase();
  if (!raw) {
    return params.fallback;
  }
  if (["1", "true", "yes", "on"].includes(raw)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(raw)) {
    return false;
  }
  throw new Error(
    `${params.name} must be one of 1,0,true,false,yes,no,on,off; got ${JSON.stringify(params.raw)}`,
  );
}

export function redactJsonValueForDevToolLog(value: unknown): unknown {
  return redactJsonValue(value, new WeakSet<object>(), 0);
}

function redactJsonValue(value: unknown, seen: WeakSet<object>, depth: number): unknown {
  if (typeof value === "string") {
    return redactForDevToolLog(value);
  }
  if (typeof value !== "object" || value === null) {
    return value;
  }
  if (depth >= 8) {
    return "[redacted: max depth]";
  }
  if (seen.has(value)) {
    return "[redacted: circular]";
  }
  seen.add(value);
  if (Array.isArray(value)) {
    return value.map((entry) => redactJsonValue(entry, seen, depth + 1));
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    result[key] = redactJsonValue(entry, seen, depth + 1);
  }
  return result;
}

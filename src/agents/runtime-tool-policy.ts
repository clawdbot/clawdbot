import type { RuntimeToolPolicy } from "../config/sessions/runtime-tool-policy.types.js";
import type { SandboxToolPolicy } from "./sandbox/types.js";
import { normalizeToolName } from "./tool-policy.js";

/** Persisted malformed values fail closed; `"none"` maps to this deny-all sentinel. */
const DENY_ALL = "*";

export function normalizeRuntimeToolPolicy(input: unknown): RuntimeToolPolicy | undefined {
  if (input === undefined) {
    return undefined;
  }
  if (input === "none") {
    return "none";
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "none";
  }

  const rawKeys = Object.keys(input);
  const knownKeys = new Set(["allow", "deny"]);
  if (rawKeys.some((k) => !knownKeys.has(k))) {
    return "none";
  }

  const raw = input as { allow?: unknown; deny?: unknown };
  const allow = cleanToolList(raw.allow);
  const deny = cleanToolList(raw.deny);

  if (allow === null || deny === null) {
    return "none";
  }

  if (deny.includes(DENY_ALL)) {
    return "none";
  }
  if (raw.allow !== undefined && allow.length === 0) {
    return "none";
  }
  if (allow.length === 0 && deny.length === 0) {
    return undefined;
  }
  if (allow.includes(DENY_ALL) && deny.length === 0) {
    return undefined;
  }

  const result: { allow?: string[]; deny?: string[] } = {};
  if (allow.length > 0) {
    result.allow = allow;
  }
  if (deny.length > 0) {
    result.deny = deny;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function runtimeToolPolicyToSandboxPolicy(
  policy: RuntimeToolPolicy | undefined,
): SandboxToolPolicy | undefined {
  if (policy === undefined) {
    return undefined;
  }
  if (policy === "none") {
    return { deny: [DENY_ALL] };
  }
  return {
    ...(policy.allow ? { allow: [...policy.allow] } : {}),
    ...(policy.deny ? { deny: [...policy.deny] } : {}),
  };
}

function runtimeToolPolicyEqual(
  a: RuntimeToolPolicy | undefined,
  b: RuntimeToolPolicy | undefined,
): boolean {
  const na = normalizeRuntimeToolPolicy(a);
  const nb = normalizeRuntimeToolPolicy(b);
  if (na === nb) {
    return true;
  }
  if (na === undefined || nb === undefined) {
    return false;
  }
  if (na === "none" || nb === "none") {
    return na === nb;
  }
  return listsEqual(na.allow, nb.allow) && listsEqual(na.deny, nb.deny);
}

/** `undefined` means no write is needed; conflicting rewrites are rejected. */
export function resolveRuntimeToolPolicyWrite(
  persisted: RuntimeToolPolicy | undefined,
  requested: RuntimeToolPolicy | undefined,
): RuntimeToolPolicy | undefined {
  const normalizedRequested = normalizeRuntimeToolPolicy(requested);
  if (normalizedRequested === undefined) {
    return undefined;
  }
  const normalizedPersisted = normalizeRuntimeToolPolicy(persisted);
  if (normalizedPersisted === undefined) {
    return normalizedRequested;
  }
  if (!runtimeToolPolicyEqual(normalizedPersisted, normalizedRequested)) {
    throw new Error(
      "runtimeToolPolicy is immutable: a child session's tool policy cannot be changed after it is set. Create a new child session for a different policy.",
    );
  }
  return undefined;
}

function listsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === undefined && b === undefined) {
    return true;
  }
  if (a === undefined || b === undefined) {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  const sa = [...a].toSorted();
  const sb = [...b].toSorted();
  return sa.every((v, i) => v === sb[i]);
}

function cleanToolList(raw: unknown): string[] | null {
  if (raw === undefined) {
    return [];
  }
  if (!Array.isArray(raw)) {
    return null;
  }
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") {
      return null;
    }
    const trimmed = entry.trim();
    if (trimmed === "") {
      continue;
    }
    const normalized = normalizeToolName(trimmed);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      result.push(normalized);
    }
  }
  return result;
}

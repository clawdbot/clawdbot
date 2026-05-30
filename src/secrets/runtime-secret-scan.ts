import { coerceSecretRef } from "../config/types.secrets.js";
import type { SecretDefaults } from "./runtime-shared.js";

const CREDENTIAL_FIELD_NAMES = new Set(["apikey", "key", "token", "secret", "password"]);

function hasRecursiveSecretValue(params: {
  value: unknown;
  defaults: SecretDefaults | undefined;
  seen: WeakSet<object>;
  matchesEntry?: (key: string, value: unknown) => boolean;
}): boolean {
  if (coerceSecretRef(params.value, params.defaults)) {
    return true;
  }
  if (!params.value || typeof params.value !== "object") {
    return false;
  }
  if (params.seen.has(params.value)) {
    return false;
  }
  params.seen.add(params.value);
  if (Array.isArray(params.value)) {
    return params.value.some((entry) => hasRecursiveSecretValue({ ...params, value: entry }));
  }
  return Object.entries(params.value as Record<string, unknown>).some(([key, entry]) => {
    if (params.matchesEntry?.(key, entry)) {
      return true;
    }
    return hasRecursiveSecretValue({ ...params, value: entry });
  });
}

export function hasSecretRefCandidate(
  value: unknown,
  defaults: SecretDefaults | undefined,
  seen = new WeakSet<object>(),
): boolean {
  return hasRecursiveSecretValue({ value, defaults, seen });
}

export function hasCredentialBearingObjectValue(
  value: unknown,
  defaults: SecretDefaults | undefined,
  seen = new WeakSet<object>(),
): boolean {
  return hasRecursiveSecretValue({
    value,
    defaults,
    seen,
    matchesEntry: (rawKey, entry) => {
      const key = rawKey.toLowerCase();
      return CREDENTIAL_FIELD_NAMES.has(key) && entry != null && entry !== "";
    },
  });
}

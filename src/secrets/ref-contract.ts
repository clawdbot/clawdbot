/** Shared SecretRef grammar and validation helpers for config, schema, SDK, and gateway parity. */
import {
  DEFAULT_SECRET_PROVIDER_ALIAS,
  type SecretRef,
  type SecretRefSource,
} from "../config/types.secrets.js";

/**
 * Runtime secret-reference grammar shared by config parsing, plugin SDK schemas,
 * gateway parity checks, and resolver planning.
 */

const FILE_SECRET_REF_SEGMENT_PATTERN = /^(?:[^~]|~0|~1)*$/;
/** Shared alias grammar for env/file/exec secret provider names. */
export const SECRET_PROVIDER_ALIAS_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
const EXEC_SECRET_REF_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/;

/** Canonical id for file secret providers that expose exactly one value. */
export const SINGLE_VALUE_FILE_REF_ID = "value";
/** JSON-schema fragment that rejects absolute file secret ref ids. */
export const FILE_SECRET_REF_ID_ABSOLUTE_JSON_SCHEMA_PATTERN = "^/";
/** JSON-schema fragment that rejects invalid JSON-pointer escape sequences. */
export const FILE_SECRET_REF_ID_INVALID_ESCAPE_JSON_SCHEMA_PATTERN = "~(?:[^01]|$)";
/** JSON-schema pattern for exec secret ref ids, excluding dot-path traversal. */
export const EXEC_SECRET_REF_ID_JSON_SCHEMA_PATTERN =
  "^(?!.*(?:^|/)\\.{1,2}(?:/|$))[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$";

/** Failure class returned when an exec secret ref id is syntactically invalid. */
export type ExecSecretRefIdValidationReason = "pattern" | "traversal-segment";

/** Result for callers that need to distinguish grammar failures from traversal attempts. */
export type ExecSecretRefIdValidationResult =
  | { ok: true }
  | {
      ok: false;
      reason: ExecSecretRefIdValidationReason;
    };

/** Minimal config shape needed to resolve default provider aliases for a secret source. */
export type SecretRefDefaultsCarrier = {
  /** Secrets config subset; callers pass full config objects or narrow test doubles. */
  secrets?: {
    /** Explicit per-source provider aliases selected by the operator. */
    defaults?: {
      /** Default provider alias for environment-variable secret refs. */
      env?: string;
      /** Default provider alias for file-backed secret refs. */
      file?: string;
      /** Default provider alias for exec-backed secret refs. */
      exec?: string;
    };
    /** Provider declarations used only when callers ask to prefer the first matching source. */
    providers?: Record<string, { source?: string }>;
  };
};

/** Builds the stable map key used to cache or compare resolved secret refs. */
export function secretRefKey(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

/** Resolves the default provider alias for one source, falling back to the built-in alias. */
export function resolveDefaultSecretProviderAlias(
  config: SecretRefDefaultsCarrier,
  source: SecretRefSource,
  options?: { preferFirstProviderForSource?: boolean },
): string {
  const configured =
    source === "env"
      ? config.secrets?.defaults?.env
      : source === "file"
        ? config.secrets?.defaults?.file
        : config.secrets?.defaults?.exec;
  if (configured?.trim()) {
    return configured.trim();
  }

  if (options?.preferFirstProviderForSource) {
    const providers = config.secrets?.providers;
    if (providers) {
      // Preserve config insertion order: interactive setup uses this as a
      // deterministic fallback only when no explicit source default exists.
      for (const [providerName, provider] of Object.entries(providers)) {
        if (provider?.source === source) {
          return providerName;
        }
      }
    }
  }

  return DEFAULT_SECRET_PROVIDER_ALIAS;
}

/** Validates file secret ref ids against the shared JSON-pointer-style contract. */
export function isValidFileSecretRefId(value: string): boolean {
  if (value === SINGLE_VALUE_FILE_REF_ID) {
    return true;
  }
  if (!value.startsWith("/")) {
    return false;
  }
  // File refs mirror JSON Pointer segment escaping; keep this in parity with gateway/schema
  // patterns so config, plugin SDK, and remote gateway validation accept the same ids.
  return value
    .slice(1)
    .split("/")
    .every((segment) => FILE_SECRET_REF_SEGMENT_PATTERN.test(segment));
}

/** Validates a secret provider alias against the shared config/gateway grammar. */
export function isValidSecretProviderAlias(value: string): boolean {
  return SECRET_PROVIDER_ALIAS_PATTERN.test(value);
}

/** Validates exec secret ref ids and reports why invalid ids failed. */
export function validateExecSecretRefId(value: string): ExecSecretRefIdValidationResult {
  if (!EXEC_SECRET_REF_ID_PATTERN.test(value)) {
    return { ok: false, reason: "pattern" };
  }
  // The JSON schema uses a negative lookahead for traversal. Runtime validation keeps the same
  // rule explicit so UI/doctor flows can explain the safer failure class.
  for (const segment of value.split("/")) {
    if (segment === "." || segment === "..") {
      return { ok: false, reason: "traversal-segment" };
    }
  }
  return { ok: true };
}

/** Boolean convenience wrapper for callers that only need accept/reject behavior. */
export function isValidExecSecretRefId(value: string): boolean {
  return validateExecSecretRefId(value).ok;
}

/** Formats the user-facing validation message for rejected exec secret ref ids. */
export function formatExecSecretRefIdValidationMessage(): string {
  return [
    "Exec secret reference id must match /^[A-Za-z0-9][A-Za-z0-9._:/#-]{0,255}$/",
    'and must not include "." or ".." path segments',
    '(example: "vault/openai/api-key" or "aws/secret#json_key").',
  ].join(" ");
}

import { expectDefined } from "@openclaw/normalization-core";
// Defines secret reference and resolution configuration types.
import { isRecord } from "../utils.js";

/** Supported secret reference backends in config. */
export type SecretRefSource = "env" | "file" | "exec"; // pragma: allowlist secret

/**
 * Stable identifier for a secret in a configured source.
 * Examples:
 * - env source: provider "default", id "OPENAI_API_KEY"
 * - file source: provider "mounted-json", id "/providers/openai/apiKey"
 * - exec source: provider "vault", id "openai/api-key"
 */
export type SecretRef = {
  source: SecretRefSource;
  provider: string;
  id: string;
};

/** Secret-bearing config input: either a literal string or a structured SecretRef. */
export type SecretInput = string | SecretRef;
/** Provider alias used when a SecretRef omits a source-specific provider. */
export const DEFAULT_SECRET_PROVIDER_ALIAS = "default"; // pragma: allowlist secret
/** Strict env-var id shape accepted for env-backed SecretRefs. */
export const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
/** Legacy env SecretRef marker retained for config migration/read compatibility. */
export const LEGACY_SECRETREF_ENV_MARKER_PREFIX = "secretref-env:"; // pragma: allowlist secret
/** Older env SecretRef marker retained for migration/read compatibility. */
export const LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX = "__env__:"; // pragma: allowlist secret
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
const ENV_SECRET_SHORTHAND_RE = /^\$([A-Z][A-Z0-9_]{0,127})$/;
/** Secret string read mode: throw on unresolved refs or inspect without resolving. */
export type SecretInputStringResolutionMode = "strict" | "inspect";
/** Result of reading a secret input without necessarily materializing the secret value. */
export type SecretInputStringResolution =
  | { status: "available"; value: string; ref: null }
  | { status: "configured_unavailable"; value: undefined; ref: SecretRef }
  | { status: "missing"; value: undefined; ref: null };
type SecretDefaults = {
  /** Default provider alias for env SecretRefs. */
  env?: string;
  /** Default provider alias for file SecretRefs. */
  file?: string;
  /** Default provider alias for exec SecretRefs. */
  exec?: string;
};

/** Return whether an env SecretRef id is a supported uppercase environment variable name. */
export function isValidEnvSecretRefId(value: string): boolean {
  return ENV_SECRET_REF_ID_RE.test(value);
}

/** Narrow a value to the canonical SecretRef object shape. */
export function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) {
    return false;
  }
  if (Object.keys(value).length !== 3) {
    return false;
  }
  return (
    (value.source === "env" || value.source === "file" || value.source === "exec") &&
    typeof value.provider === "string" &&
    value.provider.trim().length > 0 &&
    typeof value.id === "string" &&
    value.id.trim().length > 0
  );
}

function isLegacySecretRefWithoutProvider(
  value: unknown,
): value is { source: SecretRefSource; id: string } {
  if (!isRecord(value)) {
    return false;
  }
  return (
    (value.source === "env" || value.source === "file" || value.source === "exec") &&
    typeof value.id === "string" &&
    value.id.trim().length > 0 &&
    value.provider === undefined
  );
}

/** Parse `$NAME` and `${NAME}` env-secret shorthand strings into env SecretRefs. */
export function parseEnvTemplateSecretRef(
  value: unknown,
  provider = DEFAULT_SECRET_PROVIDER_ALIAS,
): SecretRef | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const match = ENV_SECRET_TEMPLATE_RE.exec(trimmed) ?? ENV_SECRET_SHORTHAND_RE.exec(trimmed);
  if (!match) {
    return null;
  }
  return {
    source: "env",
    provider: provider.trim() || DEFAULT_SECRET_PROVIDER_ALIAS,
    id: expectDefined(match[1], "types.secrets regex capture 1"),
  };
}

/** Parse legacy env SecretRef marker strings kept for config migration/read compatibility. */
export function parseLegacySecretRefEnvMarker(
  value: unknown,
  provider = DEFAULT_SECRET_PROVIDER_ALIAS,
): SecretRef | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  const prefix = trimmed.startsWith(LEGACY_SECRETREF_ENV_MARKER_PREFIX)
    ? LEGACY_SECRETREF_ENV_MARKER_PREFIX
    : trimmed.startsWith(LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX)
      ? LEGACY_DOUBLE_UNDERSCORE_ENV_MARKER_PREFIX
      : undefined;
  if (!prefix) {
    return null;
  }
  const id = trimmed.slice(prefix.length);
  if (!ENV_SECRET_REF_ID_RE.test(id)) {
    return null;
  }
  return {
    source: "env",
    provider: provider.trim() || DEFAULT_SECRET_PROVIDER_ALIAS,
    id,
  };
}

/** Coerce canonical, legacy, and env-shorthand secret inputs into a SecretRef. */
export function coerceSecretRef(value: unknown, defaults?: SecretDefaults): SecretRef | null {
  if (isSecretRef(value)) {
    return value;
  }
  const legacyEnvMarker = parseLegacySecretRefEnvMarker(value, defaults?.env);
  if (legacyEnvMarker) {
    return legacyEnvMarker;
  }
  if (isLegacySecretRefWithoutProvider(value)) {
    const provider =
      value.source === "env"
        ? (defaults?.env ?? DEFAULT_SECRET_PROVIDER_ALIAS)
        : value.source === "file"
          ? (defaults?.file ?? DEFAULT_SECRET_PROVIDER_ALIAS)
          : (defaults?.exec ?? DEFAULT_SECRET_PROVIDER_ALIAS);
    return {
      source: value.source,
      provider,
      id: value.id,
    };
  }
  const envTemplate = parseEnvTemplateSecretRef(value, defaults?.env);
  if (envTemplate) {
    return envTemplate;
  }
  return null;
}

/** Return whether a value contains either a literal secret string or resolvable SecretRef shape. */
export function hasConfiguredSecretInput(value: unknown, defaults?: SecretDefaults): boolean {
  if (normalizeSecretInputString(value)) {
    return true;
  }
  return coerceSecretRef(value, defaults) !== null;
}

/** Trim a literal secret input string while leaving non-string inputs unresolved. */
export function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function formatSecretRefLabel(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

/** Error thrown when strict secret reads encounter a configured but unresolved SecretRef. */
export class UnresolvedSecretInputError extends Error {
  readonly path: string;
  readonly ref: SecretRef;

  constructor(params: { path: string; ref: SecretRef }) {
    super(
      `${params.path}: unresolved SecretRef "${formatSecretRefLabel(params.ref)}". Resolve this command against an active gateway runtime snapshot before reading it.`,
    );
    this.name = "UnresolvedSecretInputError";
    this.path = params.path;
    this.ref = params.ref;
  }
}

/** Narrow errors from strict secret read sites without parsing user-facing messages. */
export function isUnresolvedSecretInputError(value: unknown): value is UnresolvedSecretInputError {
  return value instanceof UnresolvedSecretInputError;
}

function createUnresolvedSecretInputError(params: { path: string; ref: SecretRef }): Error {
  return new UnresolvedSecretInputError(params);
}

/** Throw when a secret field still contains an unresolved SecretRef at a read site. */
export function assertSecretInputResolved(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
  path: string;
}): void {
  const { ref } = resolveSecretInputRef({
    value: params.value,
    refValue: params.refValue,
    defaults: params.defaults,
  });
  if (!ref) {
    return;
  }
  throw createUnresolvedSecretInputError({ path: params.path, ref });
}

/** Resolve a secret field to either a literal value, a configured-unavailable ref, or missing. */
export function resolveSecretInputString(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
  path: string;
  mode?: SecretInputStringResolutionMode;
}): SecretInputStringResolution {
  const normalized = normalizeSecretInputString(params.value);
  if (normalized) {
    return {
      status: "available",
      value: normalized,
      ref: null,
    };
  }
  const { ref } = resolveSecretInputRef({
    value: params.value,
    refValue: params.refValue,
    defaults: params.defaults,
  });
  if (!ref) {
    return {
      status: "missing",
      value: undefined,
      ref: null,
    };
  }
  if ((params.mode ?? "strict") === "strict") {
    throw createUnresolvedSecretInputError({ path: params.path, ref });
  }
  return {
    status: "configured_unavailable",
    value: undefined,
    ref,
  };
}

/** Return a strict literal secret value, throwing if the field still points at a SecretRef. */
export function normalizeResolvedSecretInputString(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
  path: string;
}): string | undefined {
  const resolved = resolveSecretInputString({
    ...params,
    mode: "strict",
  });
  if (resolved.status === "available") {
    return resolved.value;
  }
  return undefined;
}

/** Resolve explicit `refValue` before inline secret references embedded in `value`. */
export function resolveSecretInputRef(params: {
  value: unknown;
  refValue?: unknown;
  defaults?: SecretDefaults;
}): {
  explicitRef: SecretRef | null;
  inlineRef: SecretRef | null;
  ref: SecretRef | null;
} {
  const explicitRef = coerceSecretRef(params.refValue, params.defaults);
  // Explicit ref fields take precedence so a literal fallback can stay beside a configured ref.
  const inlineRef = explicitRef ? null : coerceSecretRef(params.value, params.defaults);
  return {
    explicitRef,
    inlineRef,
    ref: explicitRef ?? inlineRef,
  };
}

export type EnvSecretProviderConfig = {
  source: "env";
  /** Optional env var allowlist (exact names). */
  allowlist?: string[];
};

export type FileSecretProviderMode = "singleValue" | "json"; // pragma: allowlist secret

export type FileSecretProviderConfig = {
  source: "file";
  path: string;
  mode?: FileSecretProviderMode;
  timeoutMs?: number;
  maxBytes?: number;
  allowInsecurePath?: boolean;
};

export type ManualExecSecretProviderConfig = {
  source: "exec";
  command: string;
  args?: string[];
  timeoutMs?: number;
  noOutputTimeoutMs?: number;
  maxOutputBytes?: number;
  jsonOnly?: boolean;
  env?: Record<string, string>;
  passEnv?: string[];
  trustedDirs?: string[];
  allowInsecurePath?: boolean;
  allowSymlinkCommand?: boolean;
};

export type PluginIntegrationSecretProviderConfig = {
  source: "exec";
  pluginIntegration: {
    pluginId: string;
    integrationId: string;
  };
};

export type ExecSecretProviderConfig =
  | ManualExecSecretProviderConfig
  | PluginIntegrationSecretProviderConfig;

export type SecretProviderConfig =
  | EnvSecretProviderConfig
  | FileSecretProviderConfig
  | ExecSecretProviderConfig;

export type SecretsConfig = {
  providers?: Record<string, SecretProviderConfig>;
  defaults?: {
    env?: string;
    file?: string;
    exec?: string;
  };
  resolution?: {
    maxProviderConcurrency?: number;
    maxRefsPerProvider?: number;
    maxBatchBytes?: number;
  };
};

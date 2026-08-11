// Secret input parsing shared by memory provider config and gateway-resolved snapshots.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  hasNonEmptyString,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";

/** Supported secret reference backing stores. */
type SecretRefSource = "env" | "file" | "exec" | "store";

/** Canonical secret reference shape used after gateway resolution. */
type SecretRef = {
  source: SecretRefSource;
  provider: string;
  id: string;
};

const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const LEGACY_SECRETREF_ENV_MARKER_PREFIX = "secretref-env:";
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;
const SECRET_REF_SOURCES = new Set<SecretRefSource>(["env", "file", "exec", "store"]);

/** Narrow a string to a supported SecretRef source. */
function hasSecretRefSource(value: unknown): value is SecretRefSource {
  return typeof value === "string" && SECRET_REF_SOURCES.has(value as SecretRefSource);
}

/** Detect canonical three-field SecretRef objects. */
function isSecretRef(value: unknown): value is SecretRef {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  return (
    keys.length === 3 &&
    hasSecretRefSource(value.source) &&
    hasNonEmptyString(value.provider) &&
    hasNonEmptyString(value.id)
  );
}

/** Detect legacy refs that predate explicit provider names. */
function isLegacySecretRefWithoutProvider(
  value: unknown,
): value is { source: SecretRefSource; id: string } {
  if (!isRecord(value)) {
    return false;
  }
  return (
    hasSecretRefSource(value.source) && hasNonEmptyString(value.id) && value.provider === undefined
  );
}

/** Parse env template shorthand such as "${OPENAI_API_KEY}". */
function parseEnvTemplateSecretRef(value: unknown): SecretRef | null {
  if (typeof value !== "string") {
    return null;
  }
  const match = ENV_SECRET_TEMPLATE_RE.exec(value.trim());
  if (!match) {
    return null;
  }
  return {
    source: "env",
    provider: DEFAULT_SECRET_PROVIDER_ALIAS,
    id: match[1] ?? "",
  };
}

/** Parse legacy secretref-env markers from older config snapshots. */
function parseLegacySecretRefEnvMarker(value: unknown): SecretRef | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith(LEGACY_SECRETREF_ENV_MARKER_PREFIX)) {
    return null;
  }
  const id = trimmed.slice(LEGACY_SECRETREF_ENV_MARKER_PREFIX.length);
  if (!ENV_SECRET_REF_ID_RE.test(id)) {
    return null;
  }
  return {
    source: "env",
    provider: DEFAULT_SECRET_PROVIDER_ALIAS,
    id,
  };
}

/** Coerce all accepted shipped secret reference shapes to canonical SecretRef. */
function coerceSecretRef(value: unknown): SecretRef | null {
  if (isSecretRef(value)) {
    return value;
  }
  if (isLegacySecretRefWithoutProvider(value)) {
    return {
      source: value.source,
      provider: DEFAULT_SECRET_PROVIDER_ALIAS,
      id: value.id,
    };
  }
  return parseEnvTemplateSecretRef(value) ?? parseLegacySecretRefEnvMarker(value);
}

/** Return true when a secret input has either a literal value or resolvable reference shape. */
export function hasConfiguredMemorySecretInputValue(value: unknown): boolean {
  if (normalizeOptionalString(value)) {
    return true;
  }
  return coerceSecretRef(value) !== null;
}

/** Format a ref label without revealing a resolved secret value. */
function formatSecretRefLabel(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

/** Build the unresolved-ref error used when callers bypass gateway secret resolution. */
function createUnresolvedSecretInputError(params: { path: string; ref: SecretRef }): Error {
  return new Error(
    `${params.path}: unresolved SecretRef "${formatSecretRefLabel(params.ref)}". Resolve this command against an active gateway runtime snapshot before reading it.`,
  );
}

/** Return a canonical SecretRef when the input is a supported reference shape. */
export function resolveMemorySecretInputRef(value: unknown): SecretRef | null {
  return coerceSecretRef(value);
}

/** Normalize literal secrets, or throw for refs that still require gateway resolution. */
export function normalizeResolvedMemorySecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  const normalized = normalizeOptionalString(params.value);
  if (normalized) {
    return normalized;
  }
  const ref = resolveMemorySecretInputRef(params.value);
  if (!ref) {
    return undefined;
  }
  throw createUnresolvedSecretInputError({ path: params.path, ref });
}

/** Normalize env-provided secret values before use. */
export function normalizeEnvSecretInputString(value: unknown): string | undefined {
  return normalizeOptionalString(value);
}

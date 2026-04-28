export type SecretRefSource = "env" | "file" | "exec";

export type SecretRef = {
  source: SecretRefSource;
  provider: string;
  id: string;
};

const DEFAULT_SECRET_PROVIDER_ALIAS = "default";
const ENV_SECRET_REF_ID_RE = /^[A-Z][A-Z0-9_]{0,127}$/;
const LEGACY_SECRETREF_ENV_MARKER_PREFIX = "secretref-env:";
const ENV_SECRET_TEMPLATE_RE = /^\$\{([A-Z][A-Z0-9_]{0,127})\}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeSecretInputString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function isSecretRef(value: unknown): value is SecretRef {
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

export function hasConfiguredSecretInput(value: unknown): boolean {
  if (normalizeSecretInputString(value)) {
    return true;
  }
  return coerceSecretRef(value) !== null;
}

function formatSecretRefLabel(ref: SecretRef): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

function createUnresolvedSecretInputError(params: { path: string; ref: SecretRef }): Error {
  return new Error(
    `${params.path}: unresolved SecretRef "${formatSecretRefLabel(params.ref)}". Resolve this command against an active gateway runtime snapshot before reading it.`,
  );
}

export function resolveSecretInputRef(value: unknown): SecretRef | null {
  return coerceSecretRef(value);
}

export function normalizeResolvedSecretInputString(params: {
  value: unknown;
  path: string;
}): string | undefined {
  const normalized = normalizeSecretInputString(params.value);
  if (normalized) {
    return normalized;
  }
  const ref = resolveSecretInputRef(params.value);
  if (!ref) {
    return undefined;
  }
  throw createUnresolvedSecretInputError({ path: params.path, ref });
}

export function normalizeEnvSecretInputString(value: unknown): string | undefined {
  return normalizeSecretInputString(value);
}

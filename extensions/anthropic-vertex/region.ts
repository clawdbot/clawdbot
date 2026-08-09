/**
 * Anthropic Vertex region, project, and ADC auth detection helpers. They keep
 * credential probing local to the provider plugin.
 */
import { homedir, platform } from "node:os";
import { join } from "node:path";
import type { GoogleAuthOptions } from "google-auth-library";
import { resolveProviderEndpoint } from "openclaw/plugin-sdk/provider-http";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";

const ANTHROPIC_VERTEX_DEFAULT_REGION = "global";
const ANTHROPIC_VERTEX_REGION_RE = /^[a-z0-9-]+$/;
const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
const ANTHROPIC_VERTEX_ADC_FILE_MAX_BYTES = 1024 * 1024;

type AnthropicVertexAdcCredentials = NonNullable<GoogleAuthOptions["credentials"]> & {
  project_id?: unknown;
  quota_project_id?: unknown;
};

function normalizeOptionalSecretInput(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

/** Resolve the configured Vertex region, defaulting to global. */
export function resolveAnthropicVertexRegion(env: NodeJS.ProcessEnv = process.env): string {
  const region =
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_LOCATION) ||
    normalizeOptionalSecretInput(env.CLOUD_ML_REGION);

  return region && ANTHROPIC_VERTEX_REGION_RE.test(region)
    ? region
    : ANTHROPIC_VERTEX_DEFAULT_REGION;
}

/** Resolve the Vertex project id from explicit env or ADC files. */
export function resolveAnthropicVertexProjectId(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    normalizeOptionalSecretInput(env.ANTHROPIC_VERTEX_PROJECT_ID) ||
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalSecretInput(env.GOOGLE_CLOUD_PROJECT_ID) ||
    resolveAnthropicVertexProjectIdFromAdc(env)
  );
}

/** Extract a Vertex region from a provider base URL when possible. */
export function resolveAnthropicVertexRegionFromBaseUrl(baseUrl?: string): string | undefined {
  const endpoint = resolveProviderEndpoint(baseUrl);
  return endpoint.endpointClass === "google-vertex" ? endpoint.googleVertexRegion : undefined;
}

/** Resolve the client region from model base URL first, then env fallback. */
export function resolveAnthropicVertexClientRegion(params?: {
  baseUrl?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  return (
    resolveAnthropicVertexRegionFromBaseUrl(params?.baseUrl) ||
    resolveAnthropicVertexRegion(params?.env)
  );
}

function hasAnthropicVertexMetadataServerAdc(env: NodeJS.ProcessEnv = process.env): boolean {
  const explicitMetadataOptIn = normalizeOptionalSecretInput(env.ANTHROPIC_VERTEX_USE_GCP_METADATA);
  return (
    explicitMetadataOptIn === "1" ||
    normalizeLowercaseStringOrEmpty(explicitMetadataOptIn) === "true"
  );
}

function resolveAnthropicVertexHomeDir(env: NodeJS.ProcessEnv = process.env): string {
  return (
    normalizeOptionalSecretInput(env.HOME) ||
    normalizeOptionalSecretInput(env.USERPROFILE) ||
    homedir()
  );
}

function resolveAnthropicVertexDefaultAdcPath(env: NodeJS.ProcessEnv = process.env): string {
  return platform() === "win32"
    ? join(
        normalizeOptionalSecretInput(env.APPDATA) ??
          join(resolveAnthropicVertexHomeDir(env), "AppData", "Roaming"),
        "gcloud",
        "application_default_credentials.json",
      )
    : join(
        resolveAnthropicVertexHomeDir(env),
        ".config",
        "gcloud",
        "application_default_credentials.json",
      );
}

function resolveAnthropicVertexAdcCredentialsPathCandidate(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = normalizeOptionalSecretInput(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (explicit) {
    return explicit;
  }
  return resolveAnthropicVertexDefaultAdcPath(env);
}

export function resolveAnthropicVertexAdcCredentials(
  env: NodeJS.ProcessEnv = process.env,
): AnthropicVertexAdcCredentials | undefined {
  const credentialsPath = resolveAnthropicVertexAdcCredentialsPathCandidate(env);
  const text = tryReadSecretFileSync(credentialsPath, "Anthropic Vertex ADC credentials", {
    maxBytes: ANTHROPIC_VERTEX_ADC_FILE_MAX_BYTES,
    rejectHardlinks: false,
  });
  if (!text) {
    return undefined;
  }
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Anthropic Vertex ADC credentials must be a JSON object: ${credentialsPath}`);
  }
  return parsed as AnthropicVertexAdcCredentials;
}

function canReadAnthropicVertexAdc(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return resolveAnthropicVertexAdcCredentials(env) !== undefined;
  } catch {
    return false;
  }
}

function resolveAnthropicVertexProjectIdFromAdc(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  try {
    const parsed = resolveAnthropicVertexAdcCredentials(env);
    if (!parsed) {
      return undefined;
    }
    return (
      normalizeOptionalSecretInput(parsed.project_id) ||
      normalizeOptionalSecretInput(parsed.quota_project_id)
    );
  } catch {
    return undefined;
  }
}

/** Return whether ADC credentials or metadata-server auth are available. */
export function hasAnthropicVertexCredentials(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasAnthropicVertexMetadataServerAdc(env) || canReadAnthropicVertexAdc(env);
}

/** Return whether Anthropic Vertex has usable auth for implicit registration. */
export function hasAnthropicVertexAvailableAuth(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasAnthropicVertexCredentials(env);
}

/** Resolve the synthetic config API key marker for Anthropic Vertex auth. */
export function resolveAnthropicVertexConfigApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return hasAnthropicVertexAvailableAuth(env) ? GCP_VERTEX_CREDENTIALS_MARKER : undefined;
}

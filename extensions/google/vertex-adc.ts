import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type GoogleAuthorizedUserCredentials = {
  type: "authorized_user";
  client_id?: string;
  client_secret?: string;
  refresh_token?: string;
};

type GoogleVertexAuthorizedUserToken = {
  token: string;
  expiresAtMs: number;
  credentialsPath: string;
  refreshToken: string;
};

type GoogleVertexAdcToken = {
  token: string;
  expiresAtMs: number;
};

const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_VERTEX_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
// Hold tokens slightly less long than reported expiry (Google's recommendation
// is a 60s buffer) so we don't ship a request that's already revoked when it
// leaves the gateway.
const GOOGLE_VERTEX_TOKEN_EXPIRY_BUFFER_MS = 60_000;

let cachedGoogleVertexAuthorizedUserToken: GoogleVertexAuthorizedUserToken | undefined;
let cachedGoogleAuthClient:
  | {
      promise: Promise<{
        getAccessToken: () => Promise<string | null | undefined>;
      }>;
    }
  | undefined;
let cachedGoogleVertexAdcToken: GoogleVertexAdcToken | undefined;

export function resetGoogleVertexAuthorizedUserTokenCacheForTest(): void {
  cachedGoogleVertexAuthorizedUserToken = undefined;
  cachedGoogleAuthClient = undefined;
  cachedGoogleVertexAdcToken = undefined;
}

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isGoogleVertexCredentialsMarker(
  apiKey: string | undefined,
): apiKey is undefined | typeof GCP_VERTEX_CREDENTIALS_MARKER {
  return apiKey === undefined || apiKey === GCP_VERTEX_CREDENTIALS_MARKER;
}

function resolveGoogleApplicationCredentialsPath(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const explicit = normalizeOptionalString(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (explicit) {
    return existsSync(explicit) ? explicit : undefined;
  }
  const homeDir = normalizeOptionalString(env.HOME) ?? os.homedir();
  const homeFallback = path.join(
    homeDir,
    ".config",
    "gcloud",
    "application_default_credentials.json",
  );
  if (existsSync(homeFallback)) {
    return homeFallback;
  }
  const appDataDir = normalizeOptionalString(env.APPDATA);
  if (!appDataDir) {
    return undefined;
  }
  const appDataFallback = path.join(appDataDir, "gcloud", "application_default_credentials.json");
  return existsSync(appDataFallback) ? appDataFallback : undefined;
}

async function readGoogleAuthorizedUserCredentials(
  credentialsPath: string,
): Promise<GoogleAuthorizedUserCredentials | undefined> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(credentialsPath, "utf8")) as unknown;
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return undefined;
  }
  const record = parsed as Record<string, unknown>;
  if (record.type !== "authorized_user") {
    return undefined;
  }
  return {
    type: "authorized_user",
    client_id: normalizeOptionalString(record.client_id),
    client_secret: normalizeOptionalString(record.client_secret),
    refresh_token: normalizeOptionalString(record.refresh_token),
  };
}

function readGoogleAdcCredentialsTypeSync(credentialsPath: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    const type = (parsed as { type?: unknown }).type;
    return typeof type === "string" ? type : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Returns true when a file/env Application Default Credentials source usable
 * for Google Vertex AI is detectable synchronously. We still call the function
 * `...AuthorizedUserAdcSync` for backwards compatibility with older tests; the
 * predicate now also covers:
 *
 *   1. `authorized_user` credentials file (existing case - `gcloud auth
 *      application-default login` produces this).
 *   2. `external_account` credentials file (Workload Identity Federation).
 *   3. `service_account` credentials file (raw GSA key - rarely used in
 *      OpenClaw, included for completeness).
 * Metadata-server ADC is intentionally not detected here: `google-auth-library`
 * probes the default metadata hosts asynchronously at request time, and the
 * provider wires the Vertex transport without this sync predicate.
 */
export function hasGoogleVertexAuthorizedUserAdcSync(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const credentialsPath = resolveGoogleApplicationCredentialsPath(env);
  if (credentialsPath) {
    const type = readGoogleAdcCredentialsTypeSync(credentialsPath);
    if (type === "authorized_user" || type === "external_account" || type === "service_account") {
      return true;
    }
  }
  return false;
}

async function refreshGoogleVertexAuthorizedUserAccessToken(params: {
  credentialsPath: string;
  credentials: GoogleAuthorizedUserCredentials;
  fetchImpl?: typeof fetch;
}): Promise<string> {
  const clientId = normalizeOptionalString(params.credentials.client_id);
  const clientSecret = normalizeOptionalString(params.credentials.client_secret);
  const refreshToken = normalizeOptionalString(params.credentials.refresh_token);
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Google Vertex authorized_user ADC is missing client_id, client_secret, or refresh_token.",
    );
  }

  const cached = cachedGoogleVertexAuthorizedUserToken;
  if (
    cached?.credentialsPath === params.credentialsPath &&
    cached.refreshToken === refreshToken &&
    cached.expiresAtMs - Date.now() > GOOGLE_VERTEX_TOKEN_EXPIRY_BUFFER_MS
  ) {
    return cached.token;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const response = await (params.fetchImpl ?? fetch)(GOOGLE_OAUTH_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const payload = (await response.json().catch(() => undefined)) as
    | { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown }
    | undefined;
  if (!response.ok) {
    const description = normalizeOptionalString(payload?.error_description);
    const code = normalizeOptionalString(payload?.error);
    throw new Error(
      `Google Vertex ADC token refresh failed: ${response.status}${code ? ` ${code}` : ""}${description ? ` (${description})` : ""}`,
    );
  }
  const token = normalizeOptionalString(payload?.access_token);
  if (!token) {
    throw new Error("Google Vertex ADC token refresh response did not include an access_token.");
  }
  const expiresInSeconds =
    typeof payload?.expires_in === "number" && Number.isFinite(payload.expires_in)
      ? payload.expires_in
      : 3600;
  cachedGoogleVertexAuthorizedUserToken = {
    token,
    expiresAtMs: Date.now() + Math.max(1, expiresInSeconds) * 1000,
    credentialsPath: params.credentialsPath,
    refreshToken,
  };
  return token;
}

async function resolveGoogleVertexAccessTokenViaGoogleAuth(): Promise<string> {
  // Lazy-import + cache so we don't pay the google-auth-library load cost on
  // gateway startup; only when we actually need a non-authorized_user token.
  if (!cachedGoogleAuthClient) {
    cachedGoogleAuthClient = {
      promise: import("google-auth-library").then(({ GoogleAuth }) => {
        // GoogleAuth handles every ADC variant we care about for GKE:
        // - external_account (Workload Identity Federation: STS exchange)
        // - service_account (raw GSA key: JWT-bearer)
        // - GKE Workload Identity (metadata server when no credentials file)
        // - Compute Engine / Cloud Run / GAE metadata server fallback
        // It also caches tokens internally and refreshes before expiry.
        return new GoogleAuth({
          scopes: [GOOGLE_VERTEX_OAUTH_SCOPE],
        });
      }),
    };
  }
  const auth = await cachedGoogleAuthClient.promise;

  const cached = cachedGoogleVertexAdcToken;
  if (cached && cached.expiresAtMs - Date.now() > GOOGLE_VERTEX_TOKEN_EXPIRY_BUFFER_MS) {
    return cached.token;
  }

  const token = await auth.getAccessToken();
  const normalized = normalizeOptionalString(token);
  if (!normalized) {
    throw new Error(
      "Google Vertex ADC fallback (google-auth-library) did not return an access token. " +
        "Verify the GKE Workload Identity binding (KSA \u2192 GSA), `GOOGLE_APPLICATION_CREDENTIALS`, " +
        "or other ADC source is reachable from this pod.",
    );
  }
  // google-auth-library doesn't expose token expiry on the simple
  // `getAccessToken()` return type, so we cache for a conservative 5 minutes.
  // The library itself already refreshes well before its own internal expiry,
  // so this cache is mainly to avoid hot-loop calls into the auth client.
  cachedGoogleVertexAdcToken = {
    token: normalized,
    expiresAtMs: Date.now() + 5 * 60_000,
  };
  return normalized;
}

/**
 * Resolve `Authorization: Bearer ...` headers for Google Vertex calls.
 *
 * We try the hand-rolled `authorized_user` refresh path first (preserves the
 * existing fetchImpl test seam and the OpenClaw upstream behaviour); when the
 * configured ADC source is anything other than `authorized_user` (the common
 * production cases on GKE: Workload Identity, Workload Identity Federation,
 * service-account JSON keys), we hand off to `google-auth-library` which
 * understands all of those natively.
 *
 * Note: the function is still named `...AuthorizedUserHeaders` to avoid a
 * symbol rename across the existing patch surface; the docstring above is
 * the truth, the name is legacy.
 */
export async function resolveGoogleVertexAuthorizedUserHeaders(
  fetchImpl?: typeof fetch,
): Promise<Record<string, string>> {
  const credentialsPath = resolveGoogleApplicationCredentialsPath();
  if (credentialsPath) {
    const credentials = await readGoogleAuthorizedUserCredentials(credentialsPath);
    if (credentials) {
      const token = await refreshGoogleVertexAuthorizedUserAccessToken({
        credentialsPath,
        credentials,
        fetchImpl,
      });
      return { Authorization: `Bearer ${token}` };
    }
  }
  // No file-based authorized_user ADC. Fall back to google-auth-library which
  // handles GKE Workload Identity (metadata server), Workload Identity
  // Federation (external_account), and service-account keys.
  const token = await resolveGoogleVertexAccessTokenViaGoogleAuth();
  return { Authorization: `Bearer ${token}` };
}

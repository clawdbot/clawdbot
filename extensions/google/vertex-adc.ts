// Google plugin module implements vertex adc behavior.
import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
  resolveExpiresAtMsFromDurationSeconds,
} from "openclaw/plugin-sdk/number-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";

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

type GoogleOauthTokenResponsePayload = {
  access_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_VERTEX_OAUTH_SCOPE = "https://www.googleapis.com/auth/cloud-platform";
const GOOGLE_VERTEX_ADC_TOKEN_REFRESH_TIMEOUT_MS = 30_000;
// Hold tokens slightly less long than reported expiry (Google's recommendation
// is a 60s buffer) so we don't ship a request that's already revoked when it
// leaves the gateway.
const GOOGLE_VERTEX_TOKEN_EXPIRY_BUFFER_MS = 60_000;
const GOOGLE_VERTEX_DEFAULT_TOKEN_LIFETIME_SECONDS = 3600;
const GOOGLE_VERTEX_AUTHLIB_TOKEN_CACHE_MS = 5 * 60_000;
const GOOGLE_OAUTH_TOKEN_RESPONSE_MAX_BYTES = 1024 * 1024;

let cachedGoogleVertexAuthorizedUserToken: GoogleVertexAuthorizedUserToken | undefined;
let cachedGoogleAuthClient:
  | {
      promise: Promise<{
        getAccessToken: () => Promise<string | null | undefined>;
      }>;
    }
  | undefined;
let cachedGoogleVertexAdcToken: GoogleVertexAdcToken | undefined;

function isGoogleVertexTokenFresh(expiresAtMsRaw: number, nowRaw = Date.now()): boolean {
  const expiresAtMs = asDateTimestampMs(expiresAtMsRaw);
  const nowMs = asDateTimestampMs(nowRaw);
  if (expiresAtMs === undefined || nowMs === undefined) {
    return false;
  }
  const minFreshExpiresAtMs = resolveExpiresAtMsFromDurationMs(
    GOOGLE_VERTEX_TOKEN_EXPIRY_BUFFER_MS,
    { nowMs },
  );
  return minFreshExpiresAtMs !== undefined && expiresAtMs > minFreshExpiresAtMs;
}

function resolveAuthorizedUserTokenExpiresAtMs(value: unknown, nowRaw: number): number | undefined {
  const nowMs = asDateTimestampMs(nowRaw);
  if (nowMs === undefined) {
    return undefined;
  }
  const lifetimeSeconds =
    typeof value === "number" && Number.isFinite(value)
      ? Math.max(1, value)
      : GOOGLE_VERTEX_DEFAULT_TOKEN_LIFETIME_SECONDS;
  return resolveExpiresAtMsFromDurationSeconds(lifetimeSeconds, { nowMs }) ?? nowMs;
}

function resolveGoogleAuthLibraryTokenExpiresAtMs(nowRaw = Date.now()): number | undefined {
  const nowMs = asDateTimestampMs(nowRaw);
  return nowMs === undefined
    ? undefined
    : resolveExpiresAtMsFromDurationMs(GOOGLE_VERTEX_AUTHLIB_TOKEN_CACHE_MS, { nowMs });
}

export function resetGoogleVertexAuthorizedUserTokenCacheForTest(): void {
  cachedGoogleVertexAuthorizedUserToken = undefined;
  cachedGoogleAuthClient = undefined;
  cachedGoogleVertexAdcToken = undefined;
}

export function isGoogleVertexCredentialsMarker(
  apiKey: string | undefined,
): apiKey is undefined | typeof GCP_VERTEX_CREDENTIALS_MARKER {
  return apiKey === undefined || apiKey === GCP_VERTEX_CREDENTIALS_MARKER;
}

function hasGoogleVertexProjectEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    normalizeOptionalString(env.GOOGLE_CLOUD_PROJECT) ||
    normalizeOptionalString(env.GCLOUD_PROJECT),
  );
}

function hasGoogleVertexLocationEnv(env: NodeJS.ProcessEnv): boolean {
  return Boolean(normalizeOptionalString(env.GOOGLE_CLOUD_LOCATION));
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

export function resolveGoogleVertexConfigApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return hasGoogleVertexProjectEnv(env) &&
    hasGoogleVertexLocationEnv(env) &&
    hasGoogleVertexAuthorizedUserAdcSync(env)
    ? GCP_VERTEX_CREDENTIALS_MARKER
    : undefined;
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
    isGoogleVertexTokenFresh(cached.expiresAtMs)
  ) {
    return cached.token;
  }

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: GOOGLE_VERTEX_ADC_TOKEN_REFRESH_TIMEOUT_MS,
    operation: "google-vertex-adc-token-refresh",
    url: GOOGLE_OAUTH_TOKEN_URL,
  });
  let response: Response;
  let payload: GoogleOauthTokenResponsePayload | undefined;
  try {
    response = await (params.fetchImpl ?? fetch)(GOOGLE_OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal,
    });
    // Keep the request deadline active through body consumption. Fetch resolves
    // at headers, so cleanup here would leave a stalled token body unbounded.
    payload = await readGoogleOauthTokenResponsePayload(response);
  } finally {
    cleanup();
  }
  if (!response.ok) {
    const description = normalizeOptionalString(payload?.error_description);
    const code = normalizeOptionalString(payload?.error);
    throw new Error(
      `Google Vertex ADC token refresh failed: ${response.status}${code ? ` ${code}` : ""}${description ? ` (${description})` : ""}`,
    );
  }
  if (!payload) {
    throw new Error("Google Vertex ADC token refresh response could not be parsed as JSON.");
  }
  const token = normalizeOptionalString(payload?.access_token);
  if (!token) {
    throw new Error("Google Vertex ADC token refresh response did not include an access_token.");
  }
  const nowMs = Date.now();
  const expiresAtMs = resolveAuthorizedUserTokenExpiresAtMs(payload?.expires_in, nowMs);
  if (expiresAtMs !== undefined) {
    cachedGoogleVertexAuthorizedUserToken = {
      token,
      expiresAtMs,
      credentialsPath: params.credentialsPath,
      refreshToken,
    };
  }
  return token;
}

async function readGoogleOauthTokenResponsePayload(
  response: Response,
): Promise<GoogleOauthTokenResponsePayload | undefined> {
  const bytes = await readResponseWithLimit(response, GOOGLE_OAUTH_TOKEN_RESPONSE_MAX_BYTES, {
    onOverflow: ({ maxBytes }) =>
      new Error(`Google OAuth token response exceeds ${maxBytes} bytes`),
  });
  const text = decodeGoogleOauthTokenResponseBody(bytes, response.headers.get("content-encoding"));
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as GoogleOauthTokenResponsePayload;
  } catch {
    return undefined;
  }
}

function decodeGoogleOauthTokenResponseBody(bytes: Buffer, contentEncoding: string | null): string {
  if (shouldGunzipGoogleOauthTokenResponse(bytes, contentEncoding)) {
    try {
      return gunzipSync(bytes, { maxOutputLength: GOOGLE_OAUTH_TOKEN_RESPONSE_MAX_BYTES }).toString(
        "utf8",
      );
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ERR_BUFFER_TOO_LARGE"
      ) {
        throw new Error(
          `Google OAuth token response exceeds ${GOOGLE_OAUTH_TOKEN_RESPONSE_MAX_BYTES} decompressed bytes`,
          { cause: error },
        );
      }
      return bytes.toString("utf8");
    }
  }
  return bytes.toString("utf8");
}

function shouldGunzipGoogleOauthTokenResponse(
  bytes: Buffer,
  contentEncoding: string | null,
): boolean {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return true;
  }
  return (contentEncoding ?? "")
    .split(",")
    .map((encoding) => encoding.trim().toLowerCase())
    .includes("gzip");
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
          // Best-effort cancellation for clients that use the shared transporter.
          // WIF STS and GCE metadata need the owner-level deadline below.
          clientOptions: {
            transporterOptions: { timeout: GOOGLE_VERTEX_ADC_TOKEN_REFRESH_TIMEOUT_MS },
          },
        });
      }),
    };
  }
  const authClient = cachedGoogleAuthClient;
  const auth = await authClient.promise;

  const cached = cachedGoogleVertexAdcToken;
  if (cached && isGoogleVertexTokenFresh(cached.expiresAtMs)) {
    return cached.token;
  }

  // Some google-auth-library ADC implementations bypass the configured Gaxios
  // transporter, so this owner-level deadline also bounds STS and metadata paths.
  let token: string | null | undefined;
  try {
    token = await withTimeout(auth.getAccessToken(), GOOGLE_VERTEX_ADC_TOKEN_REFRESH_TIMEOUT_MS, {
      createError: () => new DOMException("request timed out", "TimeoutError"),
    });
  } catch (error) {
    // The dependency coalesces in-flight refreshes. Drop only this timed-out
    // client so a recovered identity endpoint gets a fresh attempt next time.
    if (
      error instanceof DOMException &&
      error.name === "TimeoutError" &&
      cachedGoogleAuthClient === authClient
    ) {
      cachedGoogleAuthClient = undefined;
    }
    throw error;
  }
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
  const expiresAtMs = resolveGoogleAuthLibraryTokenExpiresAtMs();
  if (expiresAtMs !== undefined) {
    cachedGoogleVertexAdcToken = {
      token: normalized,
      expiresAtMs,
    };
  }
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

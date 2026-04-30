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

const GCP_VERTEX_CREDENTIALS_MARKER = "gcp-vertex-credentials";
const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

let cachedGoogleVertexAuthorizedUserToken: GoogleVertexAuthorizedUserToken | undefined;

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

export function hasGoogleVertexAuthorizedUserAdcSync(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const credentialsPath = resolveGoogleApplicationCredentialsPath(env);
  if (!credentialsPath) {
    return false;
  }
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath, "utf8")) as unknown;
    return (
      Boolean(parsed) &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      (parsed as { type?: unknown }).type === "authorized_user"
    );
  } catch {
    return false;
  }
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
    cached.expiresAtMs - Date.now() > 60_000
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

export async function resolveGoogleVertexAuthorizedUserHeaders(
  fetchImpl?: typeof fetch,
): Promise<Record<string, string>> {
  const credentialsPath = resolveGoogleApplicationCredentialsPath();
  if (!credentialsPath) {
    throw new Error(
      "Google Vertex ADC credentials not found. Set GOOGLE_APPLICATION_CREDENTIALS or run gcloud auth application-default login.",
    );
  }
  const credentials = await readGoogleAuthorizedUserCredentials(credentialsPath);
  if (!credentials) {
    throw new Error("Google Vertex ADC fallback requires an authorized_user credentials file.");
  }
  const token = await refreshGoogleVertexAuthorizedUserAccessToken({
    credentialsPath,
    credentials,
    fetchImpl,
  });
  return { Authorization: `Bearer ${token}` };
}

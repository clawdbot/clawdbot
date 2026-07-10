/**
 * Implements Chutes OAuth PKCE, callback parsing, token exchange, and refresh
 * for agent model authentication.
 */
import { randomBytes } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { sha256Base64Url } from "../infra/crypto-digest.js";
import { resolveExpiresAtMsFromDurationSeconds } from "../infra/parse-finite-number.js";
import type { OAuthCredentials } from "../llm/oauth.js";
import { buildOAuthRequestSignal } from "../llm/utils/oauth/abort.js";
import { assertOkOrThrowProviderError, readProviderJsonResponse } from "./provider-http-errors.js";

const CHUTES_OAUTH_REQUEST_TIMEOUT_MS = 30_000;

const CHUTES_OAUTH_ISSUER = "https://api.chutes.ai";
export const CHUTES_AUTHORIZE_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/authorize`;
export const CHUTES_TOKEN_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/token`;
export const CHUTES_USERINFO_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/userinfo`;

const DEFAULT_EXPIRES_BUFFER_MS = 5 * 60 * 1000;

type ChutesPkce = { verifier: string; challenge: string };

type ChutesUserInfo = {
  sub?: string;
  username?: string;
  created_at?: string;
};

/** OAuth client settings for the Chutes authorization-code flow. */
export type ChutesOAuthAppConfig = {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
};

type ChutesStoredOAuth = OAuthCredentials & {
  clientId?: string;
};

/** Generates a PKCE verifier/challenge pair for Chutes login. */
export function generateChutesPkce(): ChutesPkce {
  const verifier = randomBytes(32).toString("hex");
  const challenge = sha256Base64Url(verifier);
  return { verifier, challenge };
}

/** Parses pasted Chutes redirect input and enforces the expected OAuth state. */
export function parseOAuthCallbackInput(
  input: string,
  expectedState: string,
): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No input provided" };
  }

  // Manual flow must validate CSRF state; require URL (or querystring) that includes `state`.
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Code-only paste (common) is no longer accepted because it defeats state validation.
    if (
      !/\s/.test(trimmed) &&
      !trimmed.includes("://") &&
      !trimmed.includes("?") &&
      !trimmed.includes("=")
    ) {
      return { error: "Paste the full redirect URL (must include code + state)." };
    }

    // Users sometimes paste only the query string: `?code=...&state=...` or `code=...&state=...`
    const qs = trimmed.startsWith("?") ? trimmed : `?${trimmed}`;
    try {
      url = new URL(`http://localhost/${qs}`);
    } catch {
      return { error: "Paste the full redirect URL (must include code + state)." };
    }
  }

  const code = normalizeOptionalString(url.searchParams.get("code"));
  const state = normalizeOptionalString(url.searchParams.get("state"));
  if (!code) {
    return { error: "Missing 'code' parameter in URL" };
  }
  if (!state) {
    return { error: "Missing 'state' parameter. Paste the full redirect URL." };
  }
  if (state !== expectedState) {
    return { error: "OAuth state mismatch - possible CSRF attack. Please retry login." };
  }
  return { code, state };
}

function resolveChutesExpiresAt(value: unknown, now: number): number | undefined {
  return resolveExpiresAtMsFromDurationSeconds(value, {
    nowMs: now,
    bufferMs: DEFAULT_EXPIRES_BUFFER_MS,
    minRemainingMs: 30_000,
  });
}

async function cancelUnreadResponseBody(response: Response): Promise<void> {
  if (!response.bodyUsed) {
    await response.body?.cancel().catch(() => undefined);
  }
}

async function fetchChutesUserInfo(params: {
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<ChutesUserInfo | null> {
  const fetchFn = params.fetchFn ?? fetch;
  const response = await fetchFn(CHUTES_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
    signal: buildOAuthRequestSignal({ timeoutMs: CHUTES_OAUTH_REQUEST_TIMEOUT_MS }),
  });
  if (!response.ok) {
    await cancelUnreadResponseBody(response);
    return null;
  }
  const data = await readProviderJsonResponse<unknown>(response, "Chutes userinfo");
  if (!data || typeof data !== "object") {
    return null;
  }
  const typed = data as ChutesUserInfo;
  return typed;
}

/** Exchanges an authorization code for stored Chutes OAuth credentials. */
export async function exchangeChutesCodeForTokens(params: {
  app: ChutesOAuthAppConfig;
  code: string;
  codeVerifier: string;
  fetchFn?: typeof fetch;
  now?: number;
}): Promise<ChutesStoredOAuth> {
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? Date.now();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: params.app.clientId,
    code: params.code,
    redirect_uri: params.app.redirectUri,
    code_verifier: params.codeVerifier,
  });
  if (params.app.clientSecret) {
    body.set("client_secret", params.app.clientSecret);
  }

  const response = await fetchFn(CHUTES_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: buildOAuthRequestSignal({ timeoutMs: CHUTES_OAUTH_REQUEST_TIMEOUT_MS }),
  });
  await assertOkOrThrowProviderError(response, "Chutes token exchange failed");

  const data = await readProviderJsonResponse<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  }>(response, "Chutes token exchange");

  const access = data.access_token?.trim();
  const refresh = data.refresh_token?.trim();
  const expires = resolveChutesExpiresAt(data.expires_in, now);

  if (!access) {
    throw new Error("Chutes token exchange returned no access_token");
  }
  if (!refresh) {
    throw new Error("Chutes token exchange returned no refresh_token");
  }
  if (expires === undefined) {
    throw new Error("Chutes token exchange returned invalid expires_in");
  }

  let info: ChutesUserInfo | null = null;
  try {
    info = await fetchChutesUserInfo({ accessToken: access, fetchFn });
  } catch {
    // Token exchange completes authentication; optional profile enrichment must
    // not discard issued credentials when userinfo is unavailable or times out.
  }

  return {
    access,
    refresh,
    expires,
    email: info?.username,
    accountId: info?.sub,
    clientId: params.app.clientId,
  } as unknown as ChutesStoredOAuth;
}

/** Refreshes stored Chutes OAuth credentials, preserving refresh tokens when absent. */
export async function refreshChutesTokens(params: {
  credential: ChutesStoredOAuth;
  fetchFn?: typeof fetch;
  now?: number;
}): Promise<ChutesStoredOAuth> {
  const fetchFn = params.fetchFn ?? fetch;
  const now = params.now ?? Date.now();

  const refreshToken = params.credential.refresh?.trim();
  if (!refreshToken) {
    throw new Error("Chutes OAuth credential is missing refresh token");
  }

  const clientId = params.credential.clientId?.trim() ?? process.env.CHUTES_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error("Missing CHUTES_CLIENT_ID for Chutes OAuth refresh (set env var or re-auth).");
  }
  const clientSecret = normalizeOptionalString(process.env.CHUTES_CLIENT_SECRET);

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const response = await fetchFn(CHUTES_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: buildOAuthRequestSignal({ timeoutMs: CHUTES_OAUTH_REQUEST_TIMEOUT_MS }),
  });
  await assertOkOrThrowProviderError(response, "Chutes token refresh failed");

  const data = await readProviderJsonResponse<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  }>(response, "Chutes token refresh");
  const access = data.access_token?.trim();
  const newRefresh = data.refresh_token?.trim();
  const expires = resolveChutesExpiresAt(data.expires_in, now);

  if (!access) {
    throw new Error("Chutes token refresh returned no access_token");
  }
  if (expires === undefined) {
    throw new Error("Chutes token refresh returned invalid expires_in");
  }

  return {
    ...params.credential,
    access,
    // RFC 6749 section 6 makes new refresh tokens optional; Chutes may omit one
    // on refresh, so preserve the old token unless a replacement is returned.
    refresh: newRefresh || refreshToken,
    expires,
    clientId,
  } as unknown as ChutesStoredOAuth;
}

import { createHash, randomBytes } from "node:crypto";

import type { OAuthCredentials } from "@mariozechner/pi-ai";

export const CHUTES_OAUTH_ISSUER = "https://api.chutes.ai";
export const CHUTES_AUTHORIZE_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/authorize`;
export const CHUTES_TOKEN_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/token`;
export const CHUTES_USERINFO_ENDPOINT = `${CHUTES_OAUTH_ISSUER}/idp/userinfo`;

const DEFAULT_EXPIRES_BUFFER_MS = 5 * 60 * 1000;

export type ChutesPkce = { verifier: string; challenge: string };

export type ChutesUserInfo = {
  sub?: string;
  username?: string;
  created_at?: string;
};

export type ChutesOAuthAppConfig = {
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
};

export type ChutesStoredOAuth = OAuthCredentials & {
  clientId?: string;
};

export function generateChutesPkce(): ChutesPkce {
  const verifier = randomBytes(32).toString("hex");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function parseOAuthCallbackInput(
  input: string,
  expectedState: string,
): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { error: "No input provided" };

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (!code) return { error: "Missing 'code' parameter in URL" };
    if (!state) {
      return { error: "Missing 'state' parameter. Paste the full URL." };
    }
    return { code, state };
  } catch {
    if (!expectedState) {
      return { error: "Paste the full redirect URL, not just the code." };
    }
    return { code: trimmed, state: expectedState };
  }
}

function coerceExpiresAt(expiresInSeconds: number, now: number): number {
  const value =
    now +
    Math.max(0, Math.floor(expiresInSeconds)) * 1000 -
    DEFAULT_EXPIRES_BUFFER_MS;
  return Math.max(value, now + 30_000);
}

export async function fetchChutesUserInfo(params: {
  accessToken: string;
  fetchFn?: typeof fetch;
}): Promise<ChutesUserInfo | null> {
  const fetchFn = params.fetchFn ?? fetch;
  const response = await fetchFn(CHUTES_USERINFO_ENDPOINT, {
    headers: { Authorization: `Bearer ${params.accessToken}` },
  });
  if (!response.ok) return null;
  const data = (await response.json()) as unknown;
  if (!data || typeof data !== "object") return null;
  const typed = data as ChutesUserInfo;
  return typed;
}

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
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Chutes token exchange failed: ${text}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const access = data.access_token?.trim();
  const refresh = data.refresh_token?.trim();
  const expiresIn = data.expires_in ?? 0;

  if (!access)
    throw new Error("Chutes token exchange returned no access_token");
  if (!refresh) {
    throw new Error("Chutes token exchange returned no refresh_token");
  }

  const info = await fetchChutesUserInfo({ accessToken: access, fetchFn });

  return {
    access,
    refresh,
    expires: coerceExpiresAt(expiresIn, now),
    email: info?.username,
    accountId: info?.sub,
    clientId: params.app.clientId,
  } as unknown as ChutesStoredOAuth;
}

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

  const clientId =
    params.credential.clientId?.trim() ?? process.env.CHUTES_CLIENT_ID?.trim();
  if (!clientId) {
    throw new Error(
      "Missing CHUTES_CLIENT_ID for Chutes OAuth refresh (set env var or re-auth).",
    );
  }
  const clientSecret = process.env.CHUTES_CLIENT_SECRET?.trim() || undefined;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: refreshToken,
  });
  if (clientSecret) body.set("client_secret", clientSecret);

  const response = await fetchFn(CHUTES_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Chutes token refresh failed: ${text}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  const access = data.access_token?.trim();
  const newRefresh = data.refresh_token?.trim();
  const expiresIn = data.expires_in ?? 0;

  if (!access) throw new Error("Chutes token refresh returned no access_token");

  return {
    ...params.credential,
    access,
    refresh: newRefresh || refreshToken,
    expires: coerceExpiresAt(expiresIn, now),
    clientId,
  } as unknown as ChutesStoredOAuth;
}

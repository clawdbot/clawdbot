import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  MSTEAMS_DEFAULT_DELEGATED_SCOPES,
  MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS,
  MSTEAMS_OAUTH_REDIRECT_URI,
  buildMSTeamsTokenEndpoint,
  type MSTeamsDelegatedTokens,
} from "./oauth.shared.js";

/** Five-minute buffer subtracted from token expiry to avoid edge-case clock drift. */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

export async function exchangeMSTeamsCodeForTokens(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  scopes?: readonly string[];
}): Promise<MSTeamsDelegatedTokens> {
  const scopes = params.scopes ?? MSTEAMS_DEFAULT_DELEGATED_SCOPES;
  const tokenUrl = buildMSTeamsTokenEndpoint(params.tenantId);

  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    grant_type: "authorization_code",
    redirect_uri: MSTEAMS_OAUTH_REDIRECT_URI,
    code_verifier: params.verifier,
    scope: [...scopes].join(" "),
  });

  const currentFetch = globalThis.fetch;
  const { response, release } = await fetchWithSsrFGuard({
    url: tokenUrl,
    fetchImpl: async (input, guardedInit) => await currentFetch(input, guardedInit),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS),
    },
    auditContext: "msteams-oauth-token-exchange",
  });

  let data: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  try {
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MSTeams token exchange failed (${response.status}): ${errorText}`);
    }
    data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
  } finally {
    await release();
  }

  if (!data.refresh_token) {
    throw new Error("No refresh token received from Azure AD. Please try again.");
  }

  const expiresAt = Date.now() + data.expires_in * 1000 - EXPIRY_BUFFER_MS;

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresAt,
    scopes: data.scope ? data.scope.split(" ") : [...scopes],
  };
}

export async function refreshMSTeamsDelegatedTokens(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes?: readonly string[];
}): Promise<MSTeamsDelegatedTokens> {
  const scopes = params.scopes ?? MSTEAMS_DEFAULT_DELEGATED_SCOPES;
  const tokenUrl = buildMSTeamsTokenEndpoint(params.tenantId);

  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    scope: [...scopes].join(" "),
  });

  const currentFetch = globalThis.fetch;
  const { response, release } = await fetchWithSsrFGuard({
    url: tokenUrl,
    fetchImpl: async (input, guardedInit) => await currentFetch(input, guardedInit),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body,
      signal: AbortSignal.timeout(MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS),
    },
    auditContext: "msteams-oauth-token-refresh",
  });

  let data: {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
    scope?: string;
  };
  try {
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MSTeams token refresh failed (${response.status}): ${errorText}`);
    }
    data = (await response.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
      scope?: string;
    };
  } finally {
    await release();
  }

  const expiresAt = Date.now() + data.expires_in * 1000 - EXPIRY_BUFFER_MS;

  // Azure may not return a new refresh token on refresh; keep the old one
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? params.refreshToken,
    expiresAt,
    scopes: data.scope ? data.scope.split(" ") : [...scopes],
  };
}

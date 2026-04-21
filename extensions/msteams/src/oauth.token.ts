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

type MSTeamsTokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
};

function createMSTeamsTokenBody(params: {
  clientId: string;
  clientSecret: string;
  grantType: string;
  scopes: readonly string[];
  values?: Record<string, string>;
}): URLSearchParams {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    grant_type: params.grantType,
    scope: [...params.scopes].join(" "),
  });

  for (const [key, value] of Object.entries(params.values ?? {})) {
    body.set(key, value);
  }

  return body;
}

async function fetchMSTeamsTokens(params: {
  tokenUrl: string;
  body: URLSearchParams;
  auditContext: string;
  failureLabel: string;
}): Promise<MSTeamsTokenResponse> {
  const currentFetch = globalThis.fetch;
  const { response, release } = await fetchWithSsrFGuard({
    url: params.tokenUrl,
    fetchImpl: async (input, guardedInit) => await currentFetch(input, guardedInit),
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        Accept: "application/json",
      },
      body: params.body,
      signal: AbortSignal.timeout(MSTEAMS_DEFAULT_TOKEN_FETCH_TIMEOUT_MS),
    },
    auditContext: params.auditContext,
  });

  try {
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`MSTeams ${params.failureLabel} failed (${response.status}): ${errorText}`);
    }
    return (await response.json()) as MSTeamsTokenResponse;
  } finally {
    await release();
  }
}

async function requestMSTeamsDelegatedTokens(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  scopes?: readonly string[];
  grantType: string;
  values: Record<string, string>;
  auditContext: string;
  failureLabel: string;
  resolveRefreshToken: (data: MSTeamsTokenResponse) => string;
}): Promise<MSTeamsDelegatedTokens> {
  const scopes = params.scopes ?? MSTEAMS_DEFAULT_DELEGATED_SCOPES;
  const body = createMSTeamsTokenBody({
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    grantType: params.grantType,
    scopes,
    values: params.values,
  });
  const data = await fetchMSTeamsTokens({
    tokenUrl: buildMSTeamsTokenEndpoint(params.tenantId),
    body,
    auditContext: params.auditContext,
    failureLabel: params.failureLabel,
  });

  return {
    accessToken: data.access_token,
    refreshToken: params.resolveRefreshToken(data),
    expiresAt: Date.now() + data.expires_in * 1000 - EXPIRY_BUFFER_MS,
    scopes: data.scope ? data.scope.split(" ") : [...scopes],
  };
}

export async function exchangeMSTeamsCodeForTokens(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  code: string;
  verifier: string;
  scopes?: readonly string[];
}): Promise<MSTeamsDelegatedTokens> {
  return await requestMSTeamsDelegatedTokens({
    tenantId: params.tenantId,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    grantType: "authorization_code",
    scopes: params.scopes,
    values: {
      code: params.code,
      redirect_uri: MSTEAMS_OAUTH_REDIRECT_URI,
      code_verifier: params.verifier,
    },
    auditContext: "msteams-oauth-token-exchange",
    failureLabel: "token exchange",
    resolveRefreshToken: (data) => {
      if (!data.refresh_token) {
        throw new Error("No refresh token received from Azure AD. Please try again.");
      }
      return data.refresh_token;
    },
  });
}

export async function refreshMSTeamsDelegatedTokens(params: {
  tenantId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  scopes?: readonly string[];
}): Promise<MSTeamsDelegatedTokens> {
  return await requestMSTeamsDelegatedTokens({
    tenantId: params.tenantId,
    clientId: params.clientId,
    clientSecret: params.clientSecret,
    grantType: "refresh_token",
    scopes: params.scopes,
    values: {
      refresh_token: params.refreshToken,
    },
    auditContext: "msteams-oauth-token-refresh",
    failureLabel: "token refresh",
    resolveRefreshToken: (data) => data.refresh_token ?? params.refreshToken,
  });
}

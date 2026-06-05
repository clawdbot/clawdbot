// Msteams plugin module implements oauth.token behavior.
import { resolveExpiresAtMsFromDurationSeconds } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { createMSTeamsHttpError } from "./http-error.js";
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
  expiresAt: number;
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

function resolveMSTeamsTokenExpiresAt(value: unknown): number | undefined {
  return resolveExpiresAtMsFromDurationSeconds(value, { bufferMs: EXPIRY_BUFFER_MS });
}

function parseMSTeamsTokenResponse(
  data: Record<string, unknown>,
  failureLabel: string,
): MSTeamsTokenResponse {
  const expiresAt = resolveMSTeamsTokenExpiresAt(data.expires_in);
  if (
    typeof data.access_token !== "string" ||
    !data.access_token ||
    expiresAt === undefined ||
    (data.refresh_token !== undefined && typeof data.refresh_token !== "string") ||
    (data.scope !== undefined && typeof data.scope !== "string")
  ) {
    throw new Error(`MSTeams ${failureLabel} failed: invalid token response fields`);
  }

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expiresAt,
    scope: data.scope,
  };
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
      throw await createMSTeamsHttpError(response, `MSTeams ${params.failureLabel} failed`);
    }
    const data = await readProviderJsonResponse<Record<string, unknown>>(
      response,
      `MSTeams ${params.failureLabel} failed`,
    );
    return parseMSTeamsTokenResponse(data, params.failureLabel);
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
    expiresAt: data.expiresAt,
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

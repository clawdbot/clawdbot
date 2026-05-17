import { resolveOAuthClientConfig } from "./oauth.credentials.js";
import { fetchWithTimeout } from "./oauth.http.js";
import { resolveGoogleOAuthIdentity, resolveGooglePersonalOAuthIdentity } from "./oauth.project.js";
import { isGeminiCliPersonalOAuth } from "./oauth.settings.js";
import { REDIRECT_URI, TOKEN_URL, type GeminiCliOAuthCredentials } from "./oauth.shared.js";

async function requestTokenGrant(body: URLSearchParams): Promise<{
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
}> {
  const response = await fetchWithTimeout(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      Accept: "*/*",
      "User-Agent": "google-api-nodejs-client/9.15.1",
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Token exchange failed: ${errorText}`);
  }

  return (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
}

async function buildGeminiCliCredentials(params: {
  tokenResponse: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };
  refreshTokenFallback?: string;
  existing?: Pick<GeminiCliOAuthCredentials, "email" | "projectId">;
  allowIdentityFallback?: boolean;
}): Promise<GeminiCliOAuthCredentials> {
  const accessToken = params.tokenResponse.access_token;
  if (!accessToken) {
    throw new Error("No access token received. Please try again.");
  }

  let identity: { email?: string; projectId?: string } = params.existing ?? {};
  try {
    if (!identity.email || !identity.projectId) {
      const discovered = await resolveGeminiCliIdentity(accessToken);
      identity = {
        email: identity.email ?? discovered.email,
        projectId: identity.projectId ?? discovered.projectId,
      };
    }
  } catch (error) {
    if (!params.allowIdentityFallback || (!params.existing?.email && !params.existing?.projectId)) {
      throw error;
    }
    // If identity discovery is temporarily unavailable during refresh, keep the
    // already-stored identity binding instead of failing token renewal.
  }

  const expiresInMs =
    typeof params.tokenResponse.expires_in === "number"
      ? params.tokenResponse.expires_in * 1000
      : 0;
  const expiresAt = Date.now() + expiresInMs - 5 * 60 * 1000;

  return {
    refresh: params.tokenResponse.refresh_token ?? params.refreshTokenFallback ?? "",
    access: accessToken,
    expires: expiresAt,
    projectId: identity.projectId,
    email: identity.email,
  };
}

async function resolveGeminiCliIdentity(
  accessToken: string,
): Promise<{ email?: string; projectId?: string }> {
  return isGeminiCliPersonalOAuth()
    ? await resolveGooglePersonalOAuthIdentity(accessToken)
    : await resolveGoogleOAuthIdentity(accessToken);
}

export async function exchangeCodeForTokens(
  code: string,
  verifier: string,
): Promise<GeminiCliOAuthCredentials> {
  const { clientId, clientSecret } = resolveOAuthClientConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    grant_type: "authorization_code",
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  const refreshed = await buildGeminiCliCredentials({
    tokenResponse: await requestTokenGrant(body),
  });
  if (!refreshed.refresh) {
    throw new Error("No refresh token received. Please try again.");
  }
  return refreshed;
}

export async function refreshTokensForGeminiCli(credentials: {
  refresh: string;
  email?: string;
  projectId?: string;
}): Promise<GeminiCliOAuthCredentials> {
  const { clientId, clientSecret } = resolveOAuthClientConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: "refresh_token",
    refresh_token: credentials.refresh,
  });
  if (clientSecret) {
    body.set("client_secret", clientSecret);
  }

  return await buildGeminiCliCredentials({
    tokenResponse: await requestTokenGrant(body),
    refreshTokenFallback: credentials.refresh,
    existing: {
      email: credentials.email,
      projectId: credentials.projectId,
    },
    allowIdentityFallback: true,
  });
}

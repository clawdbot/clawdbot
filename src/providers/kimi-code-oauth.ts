import type { OAuthCredentials } from "@mariozechner/pi-ai";

const KIMI_CODE_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_CODE_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";

export async function refreshKimiCodeCredentials(
  credentials: OAuthCredentials,
): Promise<OAuthCredentials> {
  if (!credentials.refresh?.trim()) {
    throw new Error("Kimi Code OAuth refresh token missing; re-authenticate.");
  }

  const host = process.env.KIMI_CODE_OAUTH_HOST || KIMI_CODE_OAUTH_HOST;

  const response = await fetch(`${host}/api/oauth/token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
      client_id: KIMI_CODE_CLIENT_ID,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `Kimi Code OAuth refresh token expired or revoked. Re-authenticate with ` +
          `\`moltbot onboard --auth-choice kimi-code-oauth\`.`,
      );
    }
    throw new Error(`Kimi Code OAuth refresh failed: ${text || response.statusText}`);
  }

  const payload = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Kimi Code OAuth refresh response missing access token.");
  }

  return {
    ...credentials,
    access: payload.access_token,
    refresh: payload.refresh_token || credentials.refresh,
    expires: Date.now() + payload.expires_in * 1000,
  };
}

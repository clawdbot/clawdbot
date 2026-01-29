import type { ZoomConfig, ZoomCredentials, ZoomAccessToken } from "./types.js";

// Token cache with expiry buffer (refresh 5 minutes before expiry)
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

let cachedToken: ZoomAccessToken | null = null;

export function resolveZoomCredentials(cfg?: ZoomConfig): ZoomCredentials | undefined {
  const clientId = cfg?.clientId?.trim() || process.env.ZOOM_CLIENT_ID?.trim();
  const clientSecret = cfg?.clientSecret?.trim() || process.env.ZOOM_CLIENT_SECRET?.trim();
  const accountId = cfg?.accountId?.trim() || process.env.ZOOM_ACCOUNT_ID?.trim();
  const botJid = cfg?.botJid?.trim() || process.env.ZOOM_BOT_JID?.trim();
  const webhookSecretToken =
    cfg?.webhookSecretToken?.trim() || process.env.ZOOM_WEBHOOK_SECRET_TOKEN?.trim();

  if (!clientId || !clientSecret || !accountId || !botJid) {
    return undefined;
  }

  return { clientId, clientSecret, accountId, botJid, webhookSecretToken };
}

/**
 * Fetch a new access token using S2S OAuth credentials.
 * https://developers.zoom.us/docs/internal-apps/s2s-oauth/
 */
export async function fetchZoomAccessToken(creds: ZoomCredentials): Promise<ZoomAccessToken> {
  const authHeader = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString("base64");

  const response = await fetch("https://zoom.us/oauth/token?grant_type=client_credentials", {
    method: "POST",
    headers: {
      Authorization: `Basic ${authHeader}`,
    },
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Zoom token fetch failed (${response.status}): ${text}`);
  }

  const data = (await response.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string;
  };

  if (!data.access_token) {
    throw new Error("Zoom token response missing access_token");
  }

  return {
    accessToken: data.access_token,
    expiresAt: Date.now() + data.expires_in * 1000,
  };
}

/**
 * Get a valid access token, fetching a new one if needed.
 * Caches the token and refreshes before expiry.
 */
export async function getZoomAccessToken(creds: ZoomCredentials): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - TOKEN_EXPIRY_BUFFER_MS) {
    return cachedToken.accessToken;
  }

  cachedToken = await fetchZoomAccessToken(creds);
  return cachedToken.accessToken;
}

/**
 * Clear the cached token (useful for testing or forced refresh).
 */
export function clearZoomTokenCache(): void {
  cachedToken = null;
}

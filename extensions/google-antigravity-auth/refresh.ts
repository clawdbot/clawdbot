import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// OAuth constants - decoded from pi-ai's base64 encoded values to stay in sync
const decode = (s: string) => Buffer.from(s, "base64").toString();
const CLIENT_ID = decode(
  "MTA3MTAwNjA2MDU5MS10bWhzc2luMmgyMWxjcmUyMzV2dG9sb2poNGc0MDNlcC5hcHBzLmdvb2dsZXVzZXJjb250ZW50LmNvbQ==",
);
const CLIENT_SECRET = decode("R09DU1BYLUs1OEZXUjQ4NkxkTEoxbUxCOHNYQzR6NnFEQWY=");

export type GoogleAntigravityCredentials = {
  access: string;
  refresh: string;
  expires: number;
};

export async function refreshGoogleAntigravityCredentials(
  credentials: GoogleAntigravityCredentials,
): Promise<GoogleAntigravityCredentials> {
  if (!credentials.refresh?.trim()) {
    throw new Error("Google Antigravity OAuth refresh token missing; re-authenticate.");
  }

  const response = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: credentials.refresh,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    if (response.status === 400 || response.status === 401) {
      throw new Error(
        `Google Antigravity OAuth refresh token expired or invalid. Re-authenticate with \`clawdbot models auth login --provider google-antigravity\`.`,
      );
    }
    throw new Error(`Google Antigravity OAuth refresh failed: ${text || response.statusText}`);
  }

  const payload = await response.json();
  if (!payload.access_token || !payload.expires_in) {
    throw new Error("Google Antigravity OAuth refresh response missing access token.");
  }

  return {
    ...credentials,
    access: payload.access_token,
    refresh: payload.refresh_token || credentials.refresh,
    expires: Date.now() + payload.expires_in * 1000,
  };
}

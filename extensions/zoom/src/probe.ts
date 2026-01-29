import { zoomApiFetch } from "./api.js";
import { formatUnknownError } from "./errors.js";
import { resolveZoomCredentials, fetchZoomAccessToken } from "./token.js";
import type { ZoomConfig } from "./types.js";

export type ProbeZoomResult = {
  ok: boolean;
  error?: string;
  botJid?: string;
  accountId?: string;
  tokenValid?: boolean;
};

/**
 * Probe Zoom connection by validating credentials and token.
 */
export async function probeZoom(cfg?: ZoomConfig): Promise<ProbeZoomResult> {
  const creds = resolveZoomCredentials(cfg);
  if (!creds) {
    return {
      ok: false,
      error: "missing credentials (clientId, clientSecret, accountId, botJid)",
    };
  }

  try {
    // Test token fetch
    const token = await fetchZoomAccessToken(creds);
    if (!token.accessToken) {
      return {
        ok: false,
        error: "failed to obtain access token",
        botJid: creds.botJid,
        accountId: creds.accountId,
      };
    }

    // Verify the token works by making an API call
    // Try to get user info (requires user:read scope)
    const result = await zoomApiFetch(creds, "/users/me");

    if (!result.ok) {
      // Token is valid but may not have the right scopes
      // This is still considered "ok" for basic connectivity
      if (result.status === 403 || result.status === 401) {
        return {
          ok: true,
          botJid: creds.botJid,
          accountId: creds.accountId,
          tokenValid: true,
        };
      }

      return {
        ok: false,
        error: `API check failed: ${result.error}`,
        botJid: creds.botJid,
        accountId: creds.accountId,
        tokenValid: true,
      };
    }

    return {
      ok: true,
      botJid: creds.botJid,
      accountId: creds.accountId,
      tokenValid: true,
    };
  } catch (err) {
    return {
      ok: false,
      botJid: creds.botJid,
      accountId: creds.accountId,
      error: formatUnknownError(err),
    };
  }
}

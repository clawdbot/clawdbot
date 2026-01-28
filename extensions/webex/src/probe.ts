/**
 * Webex connection probe
 *
 * Validates bot token and connection to Webex API.
 */

import { getWebexMe, listWebexRooms, listWebexWebhooks } from "./api.js";
import type { ResolvedWebexAccount } from "./types.js";

export type WebexProbeResult = {
  ok: boolean;
  error?: string;
  bot?: {
    id: string;
    email?: string;
    displayName?: string;
  };
  rooms?: {
    count: number;
    direct: number;
    group: number;
  };
  webhooks?: {
    count: number;
    active: number;
  };
};

/**
 * Probe the Webex API to verify the bot is properly configured
 */
export async function probeWebexConnection(
  account: ResolvedWebexAccount,
): Promise<WebexProbeResult> {
  // Check if token is configured
  if (!account.botToken) {
    return {
      ok: false,
      error: "Bot token not configured",
    };
  }

  try {
    // Test authentication by getting bot info
    const me = await getWebexMe(account);

    const result: WebexProbeResult = {
      ok: true,
      bot: {
        id: me.id,
        email: me.emails?.[0],
        displayName: me.displayName,
      },
    };

    // Optionally fetch room stats
    try {
      const rooms = await listWebexRooms(account, { max: 100 });
      const direct = rooms.filter((r) => r.type === "direct").length;
      const group = rooms.filter((r) => r.type === "group").length;
      result.rooms = {
        count: rooms.length,
        direct,
        group,
      };
    } catch {
      // Room listing failed, not critical
    }

    // Optionally fetch webhook stats
    try {
      const webhooks = await listWebexWebhooks(account);
      const active = webhooks.filter((w) => w.status === "active").length;
      result.webhooks = {
        count: webhooks.length,
        active,
      };
    } catch {
      // Webhook listing failed, not critical
    }

    return result;
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Simplified probe for status checks (just tests auth)
 */
export async function probeWebexAuth(
  account: ResolvedWebexAccount,
): Promise<{ ok: boolean; error?: string }> {
  if (!account.botToken) {
    return { ok: false, error: "Bot token not configured" };
  }

  try {
    await getWebexMe(account);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

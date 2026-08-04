// Slack plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createSlackReadClient } from "./client.js";
import { formatSlackError } from "./errors.js";
import { formatSlackBotTokenIdentityWarning } from "./token.js";

export type SlackProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: { id?: string; name?: string };
  user?: { id?: string; name?: string };
  team?: { id?: string; name?: string };
  warning?: string;
};

export async function probeSlack(
  token: string,
  timeoutMs = 2500,
  opts?: { accountId?: string | null; identity?: "bot" | "user" },
): Promise<SlackProbe> {
  // The probe owns a single absolute deadline: abort its fetch and never let
  // retries or Slack's 429 queue outlive the shared health-check result.
  const client = createSlackReadClient(token, {
    rejectRateLimitedCalls: true,
    retryConfig: { retries: 0 },
    timeout: timeoutMs,
  });
  return await runChannelProbe(
    timeoutMs,
    async () => {
      const result = await client.auth.test();
      if (!result.ok) {
        return {
          ok: false,
          status: 200,
          error: result.error ?? "unknown",
        };
      }
      if (opts?.identity === "user") {
        if (result.bot_id?.trim()) {
          return {
            ok: false,
            status: 200,
            error:
              "Slack auth.test identified a bot token; user identity requires a user OAuth token",
          };
        }
        const userId = result.user_id?.trim();
        if (!userId) {
          return {
            ok: false,
            status: 200,
            error: "Slack auth.test returned no human user_id for user identity",
          };
        }
        return {
          ok: true,
          status: 200,
          user: { id: userId, name: result.user },
          team: { id: result.team_id, name: result.team },
        };
      }
      const warning = formatSlackBotTokenIdentityWarning({
        auth: result,
        accountId: opts?.accountId,
      });
      const authIdentity = { id: result.user_id, name: result.user };
      return {
        ok: true,
        status: 200,
        bot: authIdentity,
        team: { id: result.team_id, name: result.team },
        ...(warning ? { warning } : {}),
      };
    },
    (error) => ({
      ok: false,
      status:
        typeof (error as { statusCode?: number }).statusCode === "number"
          ? (error as { statusCode?: number }).statusCode
          : null,
      error: formatSlackError(error),
    }),
  );
}

// Slack plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  extractSlackErrorCode,
  formatSlackErrorWithAuthRemediation,
  isSlackAuthTokenErrorCode,
  isSlackPlatformError,
} from "./auth-error.js";
import { createSlackReadClient } from "./client.js";
import { formatSlackBotTokenIdentityWarning } from "./token.js";

export type SlackProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  /** Slack's raw error code (e.g. "not_authed"), when the failure came from a `{ ok: false }` API response rather than a network/transport error. */
  errorCode?: string;
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
      // Slack's Web API can return HTTP 200 with `{ ok: false }` in the
      // body. The SDK normally throws for that case (handled in the
      // onError callback below), but defend against it here too in case
      // that behavior ever changes upstream — HTTP success must never be
      // treated as auth success on its own.
      if (!result.ok) {
        const code = extractSlackErrorCode(result) ?? result.error ?? "unknown";
        return {
          ok: false,
          status: 200,
          error: formatSlackErrorWithAuthRemediation(result),
          errorCode: code,
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
    (error) => {
      // Slack's SDK throws a WebAPIPlatformError for `{ ok: false }` bodies
      // — that is still an HTTP 200 response, just a failed one. Treat it
      // as such (status 200) and, when it's a token-invalid code, surface
      // a clear remediation message instead of a generic error. This is
      // what keeps auth failures distinguishable from real network/timeout
      // errors (which have no Slack error code and no HTTP response at
      // all, so `statusCode` stays undefined and we fall back to null).
      if (isSlackPlatformError(error)) {
        const code = extractSlackErrorCode(error);
        return {
          ok: false,
          status: 200,
          error: formatSlackErrorWithAuthRemediation(error),
          errorCode: code,
        };
      }
      return {
        ok: false,
        status:
          typeof (error as { statusCode?: number }).statusCode === "number"
            ? (error as { statusCode?: number }).statusCode
            : null,
        error: formatSlackErrorWithAuthRemediation(error),
        errorCode: isSlackAuthTokenErrorCode(extractSlackErrorCode(error))
          ? extractSlackErrorCode(error)
          : undefined,
      };
    },
  );
}

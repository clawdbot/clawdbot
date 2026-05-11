import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import { createSlackWebClient } from "./client.js";
import { formatSlackError } from "./errors.js";

export type SlackProbe = BaseProbeResult & {
  status?: number | null;
  elapsedMs?: number | null;
  bot?: { id?: string; name?: string };
  team?: { id?: string; name?: string };
};

export async function probeSlack(token: string, timeoutMs = 2500): Promise<SlackProbe> {
  const client = createSlackWebClient(token);
  const start = Date.now();
  try {
    const result = await withTimeout(client.auth.test(), timeoutMs);
    if (!result.ok) {
      return {
        ok: false,
        status: 200,
        error: result.error ?? "unknown",
        elapsedMs: Date.now() - start,
      };
    }
    return {
      ok: true,
      status: 200,
      elapsedMs: Date.now() - start,
      bot: { id: result.user_id, name: result.user },
      team: { id: result.team_id, name: result.team },
    };
  } catch (err) {
    const message = formatSlackError(err);
    const status =
      typeof (err as { statusCode?: number }).statusCode === "number"
        ? (err as { statusCode?: number }).statusCode
        : null;
    return {
      ok: false,
      status,
      error: message,
      elapsedMs: Date.now() - start,
    };
  }
}

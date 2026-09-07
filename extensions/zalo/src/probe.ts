// Zalo plugin module implements probe behavior.
import type { BaseProbeResult } from "openclaw/plugin-sdk/channel-contract";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import { getMe, ZaloApiError, type ZaloBotInfo, type ZaloFetch } from "./api.js";

export type ZaloProbeResult = BaseProbeResult<string> & {
  bot?: ZaloBotInfo;
  elapsedMs: number;
};

function formatZaloProbeError(error: unknown, timeoutMs: number): string {
  if (error instanceof ZaloApiError) {
    return error.description ?? error.message;
  }
  if (error instanceof Error) {
    return error.name === "AbortError" ? `Request timed out after ${timeoutMs}ms` : error.message;
  }
  return String(error);
}

export async function probeZalo(
  token: string,
  timeoutMs = 5000,
  fetcher?: ZaloFetch,
): Promise<ZaloProbeResult> {
  if (!token?.trim()) {
    return { ok: false, error: "No token provided", elapsedMs: 0 };
  }

  return await runChannelProbe(
    undefined,
    async ({ elapsedMs }) => {
      const response = await getMe(token.trim(), timeoutMs, fetcher);

      if (response.ok && response.result) {
        return { ok: true, bot: response.result, elapsedMs: elapsedMs() };
      }

      return { ok: false, error: "Invalid response from Zalo API", elapsedMs: elapsedMs() };
    },
    (error) => ({ ok: false, error: formatZaloProbeError(error, timeoutMs) }),
  );
}

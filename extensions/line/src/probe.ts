// Line plugin module implements probe behavior.
import { messagingApi } from "@line/bot-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import { readLineMessageQuota } from "./message-quota.js";
import type { LineProbeResult } from "./types.js";

export async function probeLineBot(
  channelAccessToken: string,
  timeoutMs = 5000,
): Promise<LineProbeResult> {
  if (!channelAccessToken?.trim()) {
    return { ok: false, error: "Channel access token not configured" };
  }

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: channelAccessToken.trim(),
  });

  return await runChannelProbe(
    timeoutMs,
    async ({ elapsedMs }) => {
      const profile = await client.getBotInfo();
      // LINE meters monthly messages per account and stops accepting pushes once
      // the allowance runs out, so the probe reports it next to the identity an
      // operator already checks here.
      //
      // The shared probe timeout covers this whole callback, so a slow allowance
      // endpoint could otherwise time the probe out and report a healthy bot as
      // failed. It gets half of what identity left behind: enough for two small
      // reads, and bounded so the probe still answers when they stall.
      const quota = await readLineMessageQuota(
        client,
        Math.floor(Math.max(timeoutMs - elapsedMs(), 0) / 2),
      );
      return {
        ok: true,
        bot: {
          displayName: profile.displayName,
          userId: profile.userId,
          basicId: profile.basicId,
          pictureUrl: profile.pictureUrl,
        },
        ...(quota ? { quota } : {}),
      };
    },
    (error) => ({ ok: false, error: formatErrorMessage(error) }),
  );
}

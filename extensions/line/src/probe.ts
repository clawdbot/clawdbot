// Line plugin module implements probe behavior.
import { messagingApi } from "@line/bot-sdk";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runChannelProbe, withTimeout } from "openclaw/plugin-sdk/text-utility-runtime";
import type { LineProbeResult, LineProbeWebhookState } from "./types.js";

// A lookup that never settles must not spend the identity probe's deadline: this is
// an optional extra, and letting it expire the shared budget would report a channel
// broken whose token is fine. @line/bot-sdk exposes no abort plumbing, so the budget
// stops this call waiting rather than cancelling the request behind it.
const LINE_WEBHOOK_LOOKUP_BUDGET_MS = 2000;
// Headroom so the inner deadline always expires first. Without it, an identity call
// that already spent most of the probe's budget leaves both timers due on the same
// tick, and whichever wins the race decides whether a healthy token reports ok:false.
const LINE_WEBHOOK_LOOKUP_MARGIN_MS = 250;

// LINE delivers webhook events only while the channel's webhook is registered and
// switched on in the Developers Console, and no API can set that switch. Reading it
// is the only way anything downstream can tell dead inbound from healthy silence.
async function readLineWebhookState(
  client: messagingApi.MessagingApiClient,
  remainingMs: number,
): Promise<LineProbeWebhookState | undefined> {
  const budgetMs = Math.min(
    LINE_WEBHOOK_LOOKUP_BUDGET_MS,
    remainingMs - LINE_WEBHOOK_LOOKUP_MARGIN_MS,
  );
  if (budgetMs <= 0) {
    return undefined;
  }
  try {
    const registered = await withTimeout(client.getWebhookEndpoint(), budgetMs);
    // Only the switch is reported. The registered URL is not needed to act on this
    // — the operator flips Use webhook in the console — and carrying it would put a
    // URL that can hold opaque path or query credentials into logs and status output.
    return { status: registered.active ? "active" : "disabled" };
  } catch (error) {
    // A channel with no endpoint registered answers 404; the response type has no
    // shape for "none", so the error is the only way that state arrives. Every other
    // failure, this call's own expiry included, leaves the webhook unreported rather
    // than claiming it is fine or broken.
    // @line/bot-sdk HTTPFetchError exposes the response code as `status`.
    return isRecord(error) && error.status === 404 ? { status: "unset" } : undefined;
  }
}

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
      const webhook = await readLineWebhookState(client, timeoutMs - elapsedMs());
      return {
        ok: true,
        bot: {
          displayName: profile.displayName,
          userId: profile.userId,
          basicId: profile.basicId,
          pictureUrl: profile.pictureUrl,
        },
        ...(webhook ? { webhook } : {}),
      };
    },
    (error) => ({ ok: false, error: formatErrorMessage(error) }),
  );
}

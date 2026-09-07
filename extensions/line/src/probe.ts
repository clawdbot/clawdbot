import type { messagingApi } from "@line/bot-sdk";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  assertOkOrThrowHttpError,
  createProviderOperationDeadline,
  createProviderOperationTimeoutResolver,
  fetchWithTimeout,
  readProviderJsonResponse,
} from "openclaw/plugin-sdk/provider-http";
import { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { runChannelProbe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveLineAccount } from "./accounts.js";
import { resolveLineChannelAccessToken } from "./channel-access-token.js";
import type { LineMessageQuota, LineProbeResult, LineProbeWebhookState } from "./types.js";

const LINE_QUOTA_TIMEOUT_MS = 2_000;
const LINE_JSON_MAX_BYTES = 16 * 1024;

function createLineApiReader(channelAccessToken: string, timeoutMs: number) {
  const remaining = createProviderOperationTimeoutResolver({
    deadline: createProviderOperationDeadline({ timeoutMs, label: "LINE API" }),
    defaultTimeoutMs: timeoutMs,
  });
  const headers = { Authorization: `Bearer ${channelAccessToken}` };
  return async <T>(endpoint: string): Promise<T> => {
    const response = await fetchWithTimeout(
      `https://api.line.me/v2/bot/${endpoint}`,
      { headers },
      remaining(),
      fetchWithRuntimeDispatcherOrMockedGlobal,
    );
    await assertOkOrThrowHttpError(response, "LINE API", {
      bodyTimeoutMs: remaining,
      requestHeaders: headers,
    });
    // Fetch settles at headers; both body reads and later requests share this deadline.
    return await readProviderJsonResponse<T>(response, "LINE API", {
      maxBytes: LINE_JSON_MAX_BYTES,
      timeoutMs: remaining,
      requestHeaders: headers,
    });
  };
}

async function readLineMessageQuota(
  channelAccessToken: string,
  budgetMs: number,
): Promise<LineMessageQuota | undefined> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return undefined;
  }
  try {
    const read = createLineApiReader(channelAccessToken, budgetMs);
    const quota = await read<messagingApi.MessageQuotaResponse>("message/quota");
    if (quota.type === "none") {
      return { kind: "unlimited" };
    }
    if (
      quota.type !== "limited" ||
      typeof quota.value !== "number" ||
      !Number.isSafeInteger(quota.value) ||
      quota.value < 0
    ) {
      return undefined;
    }
    const { totalUsage } = await read<messagingApi.QuotaConsumptionResponse>(
      "message/quota/consumption",
    );
    return typeof totalUsage === "number" && Number.isSafeInteger(totalUsage) && totalUsage >= 0
      ? { kind: "limited", limit: quota.value, used: totalUsage }
      : undefined;
  } catch {
    return undefined;
  }
}

// LINE delivers webhook events only while the channel's webhook is registered and
// switched on in the Developers Console, and no API can set that switch. Reading it
// is the only way anything downstream can tell dead inbound from healthy silence.
async function readLineWebhookState(
  channelAccessToken: string,
  budgetMs: number,
): Promise<LineProbeWebhookState | undefined> {
  if (!Number.isFinite(budgetMs) || budgetMs <= 0) {
    return undefined;
  }
  try {
    const read = createLineApiReader(channelAccessToken, budgetMs);
    const registered = await read<messagingApi.GetWebhookEndpointResponse>(
      "channel/webhook/endpoint",
    );
    // Only the switch is reported. The registered URL is not needed to act on this
    // — the operator flips Use webhook in the console — and carrying it would put a
    // URL that can hold opaque path or query credentials into logs and status output.
    return typeof registered.active === "boolean"
      ? { status: registered.active ? "active" : "disabled" }
      : undefined;
  } catch (error) {
    // A channel with no endpoint registered answers 404; the response type has no
    // shape for "none", so the error is the only way that state arrives. Every other
    // failure, this call's own expiry included, leaves the webhook unreported rather
    // than claiming it is fine or broken.
    // The shared provider HTTP error carries the response code as `status`.
    return isRecord(error) && error.status === 404 ? { status: "unset" } : undefined;
  }
}

export async function readLineAccountMessageQuota(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): Promise<LineMessageQuota | undefined> {
  try {
    const account = resolveLineAccount({
      cfg: params.cfg,
      accountId: params.accountId ?? undefined,
    });
    return await readLineMessageQuota(
      resolveLineChannelAccessToken(undefined, account),
      LINE_QUOTA_TIMEOUT_MS,
    );
  } catch {
    return undefined;
  }
}

export async function probeLineBot(
  channelAccessToken: string,
  timeoutMs = 5000,
): Promise<LineProbeResult> {
  if (!channelAccessToken?.trim()) {
    return { ok: false, error: "Channel access token not configured" };
  }
  const token = channelAccessToken.trim();
  return await runChannelProbe(
    timeoutMs,
    async ({ elapsedMs }) => {
      const profile = await createLineApiReader(
        token,
        timeoutMs,
      )<messagingApi.BotInfoResponse>("info");
      // Reserve time to report the accepted identity even when optional reads stall.
      // Recomputed per read so a slow one shrinks the next read's budget instead of
      // spending the deadline that reports the identity we already accepted.
      const optionalBudgetMs = () => Math.floor(Math.max(timeoutMs - elapsedMs(), 0) / 2);
      const quota = await readLineMessageQuota(token, optionalBudgetMs());
      const webhook = await readLineWebhookState(token, optionalBudgetMs());
      return {
        ok: true,
        bot: {
          displayName: profile.displayName,
          userId: profile.userId,
          basicId: profile.basicId,
          pictureUrl: profile.pictureUrl,
        },
        ...(webhook ? { webhook } : {}),
        ...(quota ? { quota } : {}),
      };
    },
    (error) => ({ ok: false, error: formatErrorMessage(error) }),
  );
}

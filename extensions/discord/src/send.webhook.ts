import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import { resolveDiscordClientAccountContext } from "./client.js";
import {
  DiscordError,
  RateLimitError,
  readDiscordCode,
  readDiscordMessage,
  readRetryAfter,
} from "./internal/rest-errors.js";
import { rewriteDiscordKnownMentions } from "./mentions.js";
import type { DiscordSendResult } from "./send.types.js";

type DiscordWebhookSendOpts = {
  cfg: OpenClawConfig;
  webhookId: string;
  webhookToken: string;
  accountId?: string;
  threadId?: string | number;
  replyTo?: string;
  username?: string;
  avatarUrl?: string;
  wait?: boolean;
};

function resolveWebhookExecutionUrl(params: {
  webhookId: string;
  webhookToken: string;
  threadId?: string | number;
  wait?: boolean;
}) {
  const baseUrl = new URL(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(params.webhookId)}/${encodeURIComponent(params.webhookToken)}`,
  );
  baseUrl.searchParams.set("wait", params.wait === false ? "false" : "true");
  if (params.threadId !== undefined && params.threadId !== null && params.threadId !== "") {
    baseUrl.searchParams.set("thread_id", String(params.threadId));
  }
  return baseUrl.toString();
}

function coerceWebhookErrorBody(raw: string): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { message: raw.slice(0, 200) };
  }
}

async function throwWebhookResponseError(response: Response): Promise<never> {
  const raw = await response.text().catch(() => "");
  const parsed = coerceWebhookErrorBody(raw);
  if (response.status === 429) {
    throw new RateLimitError(response, {
      message: readDiscordMessage(parsed, "Rate limited"),
      retry_after: readRetryAfter(parsed, response, 1),
      code: readDiscordCode(parsed),
      global:
        parsed && typeof parsed === "object" && "global" in parsed
          ? Boolean((parsed as { global?: unknown }).global)
          : false,
    });
  }
  throw new DiscordError(response, parsed);
}

export async function sendWebhookMessageDiscord(
  text: string,
  opts: DiscordWebhookSendOpts,
): Promise<DiscordSendResult> {
  const webhookId = normalizeOptionalString(opts.webhookId) ?? "";
  const webhookToken = normalizeOptionalString(opts.webhookToken) ?? "";
  if (!webhookId || !webhookToken) {
    throw new Error("Discord webhook id/token are required");
  }

  const replyTo = normalizeOptionalString(opts.replyTo) ?? "";
  const messageReference = replyTo ? { message_id: replyTo, fail_if_not_exists: false } : undefined;
  const { account, proxyFetch } = resolveDiscordClientAccountContext({
    cfg: opts.cfg,
    accountId: opts.accountId,
  });
  const rewrittenText = rewriteDiscordKnownMentions(text, {
    accountId: account.accountId,
    mentionAliases: account.config.mentionAliases,
  });

  const response = await (proxyFetch ?? fetch)(
    resolveWebhookExecutionUrl({
      webhookId,
      webhookToken,
      threadId: opts.threadId,
      wait: opts.wait,
    }),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        content: rewrittenText,
        username: normalizeOptionalString(opts.username),
        avatar_url: normalizeOptionalString(opts.avatarUrl),
        ...(messageReference ? { message_reference: messageReference } : {}),
      }),
    },
  );
  if (!response.ok) {
    await throwWebhookResponseError(response);
  }

  const payload = (await response.json().catch(() => ({}))) as {
    id?: string;
    channel_id?: string;
  };
  try {
    recordChannelActivity({
      channel: "discord",
      accountId: account.accountId,
      direction: "outbound",
    });
  } catch {
    // Best-effort telemetry only.
  }
  return {
    messageId: payload.id || "unknown",
    channelId: payload.channel_id ? payload.channel_id : opts.threadId ? String(opts.threadId) : "",
  };
}

// Discord plugin module implements send.webhook behavior.
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { recordOutboundMessageIdentity } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveDiscordClientAccountContext } from "./client.js";
import {
  DiscordError,
  RateLimitError,
  readDiscordCode,
  readDiscordMessage,
  readRetryAfter,
} from "./internal/rest-errors.js";
import { rewriteDiscordKnownMentions } from "./mentions.js";
import { createDiscordSendResult } from "./send.receipt.js";
import type { DiscordSendResult } from "./send.types.js";

const DISCORD_WEBHOOK_ERROR_BODY_LIMIT_BYTES = 8 * 1024;

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
    return { message: truncateUtf16Safe(raw, 200) };
  }
}

async function throwWebhookResponseError(response: Response): Promise<never> {
  const raw = await readResponseTextLimited(response, DISCORD_WEBHOOK_ERROR_BODY_LIMIT_BYTES).catch(
    () => "",
  );
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
  const threadConversationId = opts.threadId == null ? "" : String(opts.threadId).trim();
  if (threadConversationId) {
    // Reserve the webhook source before the request so an immediate gateway echo
    // cannot outrun the response that supplies the concrete message id.
    recordOutboundMessageIdentity({
      channel: "discord",
      accountId: account.accountId,
      conversationId: threadConversationId,
      sourceId: webhookId,
    });
  }

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

  const payload: {
    id?: string;
    channel_id?: string;
  } =
    response.status === 204
      ? {}
      : await readProviderJsonResponse<{ id?: string; channel_id?: string }>(
          response,
          "Discord webhook send",
        ).catch(() => ({}));
  try {
    recordChannelActivity({
      channel: "discord",
      accountId: account.accountId,
      direction: "outbound",
    });
  } catch {
    // Best-effort telemetry only.
  }
  const result = createDiscordSendResult({
    result: payload,
    fallbackChannelId: opts.threadId ? String(opts.threadId) : "",
    kind: "text",
    ...(opts.threadId != null ? { threadId: opts.threadId } : {}),
    ...(replyTo ? { replyToId: replyTo } : {}),
  });
  const resultConversationId = result.channelId.trim();
  if (result.messageId !== "unknown" && resultConversationId) {
    recordOutboundMessageIdentity({
      channel: "discord",
      accountId: account.accountId,
      conversationId: resultConversationId,
      messageId: result.messageId,
      sourceId: webhookId,
    });
  }
  return result;
}

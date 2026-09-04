// Discord plugin module implements send.webhook behavior.
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { recordOutboundMessageIdentity } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expectDefined } from "openclaw/plugin-sdk/expect-runtime";
import { buildTimeoutAbortSignal } from "openclaw/plugin-sdk/extension-shared";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { chunkDiscordTextWithMode } from "./chunk.js";
import { resolveDiscordClientAccountContext } from "./client.js";
import {
  DiscordError,
  RateLimitError,
  readDiscordCode,
  readDiscordMessage,
  readRetryAfter,
} from "./internal/rest-errors.js";
import { rewriteDiscordKnownMentions } from "./mentions.js";
import { DISCORD_REST_TIMEOUT_MS } from "./proxy-request-client.js";
import { createDiscordRetryRunner, recordDiscordMessageCreateAmbiguity } from "./retry.js";
import {
  resolveDiscordMessageFlags,
  resolveDiscordSuppressEmbeds,
} from "./send.message-request.js";
import { createDiscordSendReceiptFromResults, createDiscordSendResult } from "./send.receipt.js";
import type { DiscordSendResult } from "./send.types.js";

const DISCORD_WEBHOOK_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const DISCORD_WEBHOOK_TIMEOUT_MS = DISCORD_REST_TIMEOUT_MS;

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
  onPlatformSendDispatch?: () => Promise<void>;
  assertPlatformSendAuthorized?: () => void;
  onDeliveryResult?: (result: DiscordSendResult) => Promise<void> | void;
};

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

function throwIfWebhookDeadlineExpired(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Discord webhook send timed out");
}

async function throwWebhookResponseError(
  response: Response,
  signal: AbortSignal | undefined,
): Promise<never> {
  const raw = await readResponseTextLimited(response, DISCORD_WEBHOOK_ERROR_BODY_LIMIT_BYTES, {
    // The request deadline owns every body read; a shorter shared idle bound
    // would turn a stalled Discord response into the wrong error class.
    chunkTimeoutMs: DISCORD_WEBHOOK_TIMEOUT_MS,
  }).catch(() => {
    throwIfWebhookDeadlineExpired(signal);
    return "";
  });
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
  const flags = resolveDiscordMessageFlags({
    suppressEmbeds: resolveDiscordSuppressEmbeds({ configured: account.config.suppressEmbeds }),
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

  const url = new URL(
    `https://discord.com/api/v10/webhooks/${encodeURIComponent(webhookId)}/${encodeURIComponent(webhookToken)}`,
  );
  url.searchParams.set("wait", opts.wait === false ? "false" : "true");
  if (opts.threadId != null && opts.threadId !== "") {
    url.searchParams.set("thread_id", String(opts.threadId));
  }
  const deadline = buildTimeoutAbortSignal({
    timeoutMs: DISCORD_WEBHOOK_TIMEOUT_MS,
    operation: "discord.webhook.send",
  });
  const request = createDiscordRetryRunner({ signal: deadline.signal });
  // Alias expansion happens after the outer delivery planner. Bound the actual
  // wire text here, retaining each accepted part before another can fail.
  const chunks = chunkDiscordTextWithMode(rewrittenText, { maxLines: Number.MAX_SAFE_INTEGER });
  const results: DiscordSendResult[] = [];
  try {
    for (const content of chunks.length ? chunks : [""]) {
      const response = await request(
        async () => {
          await opts.onPlatformSendDispatch?.();
          opts.assertPlatformSendAuthorized?.();
          const attemptResponse = await (proxyFetch ?? fetch)(url.toString(), {
            method: "POST",
            headers: {
              "content-type": "application/json",
            },
            body: JSON.stringify({
              content,
              username: normalizeOptionalString(opts.username),
              avatar_url: normalizeOptionalString(opts.avatarUrl),
              ...(flags ? { flags } : {}),
              ...(messageReference ? { message_reference: messageReference } : {}),
            }),
            signal: deadline.signal,
          });
          if (!attemptResponse.ok) {
            await throwWebhookResponseError(attemptResponse, deadline.signal);
          }
          return attemptResponse;
        },
        "webhook",
        // Webhooks cannot enforce a Discord nonce, so replay only explicit 429s
        // and proven pre-connect failures; an ambiguous 5xx could duplicate delivery.
        { safety: "non-idempotent-create" },
      );

      const payload: {
        id?: string;
        channel_id?: string;
      } =
        response.status === 204
          ? {}
          : await readProviderJsonResponse<{ id?: string; channel_id?: string }>(
              response,
              "Discord webhook send",
            ).catch(() => {
              throwIfWebhookDeadlineExpired(deadline.signal);
              return {};
            });
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
      if (result.messageId && resultConversationId) {
        recordOutboundMessageIdentity({
          channel: "discord",
          accountId: account.accountId,
          conversationId: resultConversationId,
          messageId: result.messageId,
          sourceId: webhookId,
        });
      }
      results.push(result);
      await opts.onDeliveryResult?.(result);
    }
    const last = expectDefined(results.at(-1), "Discord webhook delivery result");
    return results.length === 1
      ? last
      : { ...last, receipt: createDiscordSendReceiptFromResults({ results }) };
  } catch (error) {
    // A later rejection cannot authorize replay of earlier accepted chunks.
    if (results.length) {
      recordDiscordMessageCreateAmbiguity(error);
    }
    throw error;
  } finally {
    // The same deadline owns the request and every response-body read.
    deadline.cleanup();
  }
}

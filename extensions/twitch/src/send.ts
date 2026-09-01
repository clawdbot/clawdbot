/**
 * Twitch message sending functions with dependency injection support.
 *
 * These functions are the primary interface for sending messages to Twitch.
 * They support dependency injection via the `deps` parameter for testability.
 */

import {
  createMessageReceiptFromOutboundResults,
  type MessageReceipt,
  type MessageReceiptSourceResult,
} from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getClientManager as getRegistryClientManager } from "./client-manager-registry.js";
import { resolveTwitchAccountContext } from "./config.js";
import { stripMarkdownForTwitch } from "./utils/markdown.js";
import { generateMessageId, normalizeTwitchChannel } from "./utils/twitch.js";

/**
 * Result from sending a message to Twitch.
 */
interface SendMessageResult {
  outcome?: MessageReceiptSourceResult["outcome"];
  /** Whether the send was successful */
  ok: boolean;
  /** The message ID (generated for tracking) */
  messageId: string;
  /** Receipt for visible sends; empty when no Twitch message was sent */
  receipt: MessageReceipt;
  /** Error message if the send failed */
  error?: string;
}

function createTwitchSendReceipt(messageId?: string, channel?: string): MessageReceipt {
  return createMessageReceiptFromOutboundResults({
    results: messageId ? [{ channel: "twitch", messageId, conversationId: channel }] : [],
    kind: "text",
  });
}

/**
 * Internal send function used by the outbound adapter.
 *
 * This function has access to the full OpenClaw config and handles
 * account resolution, markdown stripping, and actual message sending.
 *
 * @param channel - The channel name
 * @param text - The message text
 * @param cfg - Full OpenClaw configuration
 * @param accountId - Account ID to use
 * @param stripMarkdown - Whether to strip markdown (default: true)
 * @param logger - Logger instance
 * @returns Result with message ID and status
 *
 * @example
 * const result = await sendMessageTwitchInternal(
 *   "#mychannel",
 *   "Hello Twitch!",
 *   openclawConfig,
 *   "default",
 *   true,
 *   console,
 * );
 */
export async function sendMessageTwitchInternal(
  channel: string,
  text: string,
  cfg: OpenClawConfig,
  accountId?: string,
  stripMarkdown = true,
  logger: Console = console,
): Promise<SendMessageResult> {
  const {
    account,
    configured,
    availableAccountIds,
    accountId: resolvedAccountId,
  } = resolveTwitchAccountContext(cfg, accountId);
  if (!account) {
    return {
      ok: false,
      messageId: generateMessageId(),
      receipt: createTwitchSendReceipt(),
      error: `Account not found: ${accountId ?? "(default)"}. Available accounts: ${availableAccountIds.join(", ") || "none"}`,
    };
  }

  if (!configured) {
    return {
      ok: false,
      messageId: generateMessageId(),
      receipt: createTwitchSendReceipt(),
      error:
        `Account ${resolvedAccountId} is not properly configured. ` +
        "Required: username, clientId, and token (config or env for default account).",
    };
  }

  const normalizedChannel = channel || account.channel;
  if (!normalizedChannel) {
    return {
      ok: false,
      messageId: generateMessageId(),
      receipt: createTwitchSendReceipt(),
      error: "No channel specified and no default channel in account config",
    };
  }
  const deliveryChannel = normalizeTwitchChannel(normalizedChannel);

  const cleanedText = stripMarkdown ? stripMarkdownForTwitch(text) : text;
  if (!cleanedText) {
    return {
      ok: true,
      outcome: "not_sent",
      messageId: "",
      receipt: createTwitchSendReceipt(),
    };
  }

  const clientManager = getRegistryClientManager(resolvedAccountId);
  if (!clientManager) {
    return {
      ok: false,
      messageId: generateMessageId(),
      receipt: createTwitchSendReceipt(),
      error: `Client manager not found for account: ${resolvedAccountId}. Please start the Twitch gateway first.`,
    };
  }

  try {
    const result = await clientManager.sendMessage(
      account,
      deliveryChannel,
      cleanedText,
      cfg,
      resolvedAccountId,
    );

    if (!result.ok) {
      const messageId = result.messageId ?? generateMessageId();
      return {
        ok: false,
        messageId,
        receipt: createTwitchSendReceipt(),
        error: result.error ?? "Send failed",
      };
    }

    const messageId = result.messageId ?? generateMessageId();
    return {
      ok: true,
      messageId,
      receipt: createTwitchSendReceipt(messageId, deliveryChannel),
    };
  } catch (error) {
    const errorMsg = formatErrorMessage(error);
    const messageId = generateMessageId();
    logger.error(`Failed to send message: ${errorMsg}`);
    return {
      ok: false,
      messageId,
      receipt: createTwitchSendReceipt(),
      error: errorMsg,
    };
  }
}

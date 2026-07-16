/**
 * Twitch message sending functions with dependency injection support.
 *
 * These functions are the primary interface for sending messages to Twitch.
 * They support dependency injection via the `deps` parameter for testability.
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { getClientManager as getRegistryClientManager } from "./client-manager-registry.js";
import { resolveTwitchAccountContext } from "./config.js";
import { stripMarkdownForTwitch } from "./utils/markdown.js";
import { generateMessageId, normalizeTwitchChannel } from "./utils/twitch.js";

/**
 * Result from sending a message to Twitch.
 */
export interface SendMessageResult {
  /** Whether the send was successful */
  ok: boolean;
  /** The message ID (generated for tracking) */
  messageId: string;
  /** Error message if the send failed */
  error?: string;
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
  stripMarkdown: boolean = true,
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
      error: `Account not found: ${accountId ?? "(default)"}. Available accounts: ${availableAccountIds.join(", ") || "none"}`,
    };
  }

  if (!configured) {
    return {
      ok: false,
      messageId: generateMessageId(),
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
      error: "No channel specified and no default channel in account config",
    };
  }

  const cleanedText = stripMarkdown ? stripMarkdownForTwitch(text) : text;
  if (!cleanedText) {
    return {
      ok: true,
      messageId: "skipped",
    };
  }

  const clientManager = getRegistryClientManager(resolvedAccountId);
  if (!clientManager) {
    return {
      ok: false,
      messageId: generateMessageId(),
      error: `Client manager not found for account: ${resolvedAccountId}. Please start the Twitch gateway first.`,
    };
  }

  try {
    const result = await clientManager.sendMessage(
      account,
      normalizeTwitchChannel(normalizedChannel),
      cleanedText,
      cfg,
      resolvedAccountId,
    );

    if (!result.ok) {
      return {
        ok: false,
        messageId: result.messageId ?? generateMessageId(),
        error: result.error ?? "Send failed",
      };
    }

    return {
      ok: true,
      messageId: result.messageId ?? generateMessageId(),
    };
  } catch (error) {
    const errorMsg = formatErrorMessage(error);
    logger.error(`Failed to send message: ${errorMsg}`);
    return {
      ok: false,
      messageId: generateMessageId(),
      error: errorMsg,
    };
  }
}

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import type { StoredConversationReference } from "./conversation-store.js";
import { createMSTeamsConversationStoreFs } from "./conversation-store-fs.js";
import {
  classifyMSTeamsSendError,
  formatMSTeamsSendErrorHint,
  formatUnknownError,
} from "./errors.js";
import {
  buildConversationReference,
  type MSTeamsAdapter,
  sendMSTeamsMessages,
} from "./messenger.js";
import { buildMSTeamsPollCard } from "./polls.js";
import { resolveMSTeamsSendContext } from "./send-context.js";

export type SendMSTeamsMessageParams = {
  /** Full config (for credentials) */
  cfg: ClawdbotConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Message text */
  text: string;
  /** Optional media URL */
  mediaUrl?: string;
};

export type SendMSTeamsMessageResult = {
  messageId: string;
  conversationId: string;
};

export type SendMSTeamsPollParams = {
  /** Full config (for credentials) */
  cfg: ClawdbotConfig;
  /** Conversation ID or user ID to send to */
  to: string;
  /** Poll question */
  question: string;
  /** Poll options */
  options: string[];
  /** Max selections (defaults to 1) */
  maxSelections?: number;
};

export type SendMSTeamsPollResult = {
  pollId: string;
  messageId: string;
  conversationId: string;
};

function extractMessageId(response: unknown): string | null {
  if (!response || typeof response !== "object") return null;
  if (!("id" in response)) return null;
  const { id } = response as { id?: unknown };
  if (typeof id !== "string" || !id) return null;
  return id;
}

async function sendMSTeamsActivity(params: {
  adapter: MSTeamsAdapter;
  appId: string;
  conversationRef: StoredConversationReference;
  activity: Record<string, unknown>;
}): Promise<string> {
  const baseRef = buildConversationReference(params.conversationRef);
  const proactiveRef = {
    ...baseRef,
    activityId: undefined,
  };
  let messageId = "unknown";
  await params.adapter.continueConversation(params.appId, proactiveRef, async (ctx) => {
    const response = await ctx.sendActivity(params.activity);
    messageId = extractMessageId(response) ?? "unknown";
  });
  return messageId;
}

/**
 * Send a message to a Teams conversation or user.
 *
 * Uses the stored ConversationReference from previous interactions.
 * The bot must have received at least one message from the conversation
 * before proactive messaging works.
 */
export async function sendMessageMSTeams(
  params: SendMSTeamsMessageParams,
): Promise<SendMSTeamsMessageResult> {
  const { cfg, to, text, mediaUrl } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  log.debug("sending proactive message", {
    conversationId,
    textLength: text.length,
    hasMedia: Boolean(mediaUrl),
  });

  const message = mediaUrl ? (text ? `${text}\n\n${mediaUrl}` : mediaUrl) : text;
  let messageIds: string[];
  try {
    messageIds = await sendMSTeamsMessages({
      replyStyle: "top-level",
      adapter,
      appId,
      conversationRef: ref,
      messages: [message],
      // Enable default retry/backoff for throttling/transient failures.
      retry: {},
      onRetry: (event) => {
        log.debug("retrying send", { conversationId, ...event });
      },
    });
  } catch (err) {
    const classification = classifyMSTeamsSendError(err);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `msteams send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
    );
  }
  const messageId = messageIds[0] ?? "unknown";

  log.info("sent proactive message", { conversationId, messageId });

  return {
    messageId,
    conversationId,
  };
}

/**
 * Send a poll (Adaptive Card) to a Teams conversation or user.
 */
export async function sendPollMSTeams(
  params: SendMSTeamsPollParams,
): Promise<SendMSTeamsPollResult> {
  const { cfg, to, question, options, maxSelections } = params;
  const { adapter, appId, conversationId, ref, log } = await resolveMSTeamsSendContext({
    cfg,
    to,
  });

  const pollCard = buildMSTeamsPollCard({
    question,
    options,
    maxSelections,
  });

  log.debug("sending poll", {
    conversationId,
    pollId: pollCard.pollId,
    optionCount: pollCard.options.length,
  });

  const activity = {
    type: "message",
    text: pollCard.fallbackText,
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: pollCard.card,
      },
    ],
  };

  let messageId: string;
  try {
    messageId = await sendMSTeamsActivity({
      adapter,
      appId,
      conversationRef: ref,
      activity,
    });
  } catch (err) {
    const classification = classifyMSTeamsSendError(err);
    const hint = formatMSTeamsSendErrorHint(classification);
    const status = classification.statusCode ? ` (HTTP ${classification.statusCode})` : "";
    throw new Error(
      `msteams poll send failed${status}: ${formatUnknownError(err)}${hint ? ` (${hint})` : ""}`,
    );
  }

  log.info("sent poll", { conversationId, pollId: pollCard.pollId, messageId });

  return {
    pollId: pollCard.pollId,
    messageId,
    conversationId,
  };
}

/**
 * List all known conversation references (for debugging/CLI).
 */
export async function listMSTeamsConversations(): Promise<
  Array<{
    conversationId: string;
    userName?: string;
    conversationType?: string;
  }>
> {
  const store = createMSTeamsConversationStoreFs();
  const all = await store.list();
  return all.map(({ conversationId, reference }) => ({
    conversationId,
    userName: reference.user?.name,
    conversationType: reference.conversation?.conversationType,
  }));
}

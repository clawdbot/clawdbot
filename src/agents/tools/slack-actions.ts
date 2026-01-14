import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { ClawdbotConfig } from "../../config/config.js";
import { resolveSlackAccount } from "../../slack/accounts.js";
import {
  deleteSlackMessage,
  editSlackMessage,
  getSlackMemberInfo,
  listSlackEmojis,
  listSlackPins,
  listSlackReactions,
  pinSlackMessage,
  reactSlackMessage,
  readSlackMessages,
  removeOwnSlackReactions,
  removeSlackReaction,
  sendSlackMessage,
  unpinSlackMessage,
} from "../../slack/actions.js";
import {
  createActionGate,
  jsonResult,
  readReactionParams,
  readStringParam,
} from "./common.js";

const messagingActions = new Set([
  "sendMessage",
  "editMessage",
  "deleteMessage",
  "readMessages",
]);

const reactionsActions = new Set(["react", "reactions"]);
const pinActions = new Set(["pinMessage", "unpinMessage", "listPins"]);

export type SlackActionContext = {
  /** Current channel ID for auto-threading. */
  currentChannelId?: string;
  /** Current thread timestamp for auto-threading. */
  currentThreadTs?: string;
  /** Reply-to mode for auto-threading. */
  replyToMode?: "off" | "first" | "all";
  /** Mutable ref to track if a reply was sent (for "first" mode). */
  hasRepliedRef?: { value: boolean };
};

/**
 * Resolve threadTs for a Slack message based on context and replyToMode.
 * - "all": always inject threadTs
 * - "first": inject only for first message (updates hasRepliedRef)
 * - "off": never auto-inject
 */
function resolveThreadTsFromContext(
  explicitThreadTs: string | undefined,
  targetChannel: string,
  context: SlackActionContext | undefined,
): string | undefined {
  // Agent explicitly provided threadTs - use it
  if (explicitThreadTs) return explicitThreadTs;
  // No context or missing required fields
  if (!context?.currentThreadTs || !context?.currentChannelId) return undefined;

  // Normalize target (strip "channel:" prefix if present)
  const normalizedTarget = targetChannel.startsWith("channel:")
    ? targetChannel.slice("channel:".length)
    : targetChannel;

  // Different channel - don't inject
  if (normalizedTarget !== context.currentChannelId) return undefined;

  // Check replyToMode
  if (context.replyToMode === "all") {
    return context.currentThreadTs;
  }
  if (
    context.replyToMode === "first" &&
    context.hasRepliedRef &&
    !context.hasRepliedRef.value
  ) {
    context.hasRepliedRef.value = true;
    return context.currentThreadTs;
  }
  return undefined;
}

export async function handleSlackAction(
  params: Record<string, unknown>,
  cfg: ClawdbotConfig,
  context?: SlackActionContext,
): Promise<AgentToolResult<unknown>> {
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const accountOpts = accountId ? { accountId } : undefined;
  const account = resolveSlackAccount({ cfg, accountId });
  const actionConfig = account.actions ?? cfg.channels?.slack?.actions;
  const isActionEnabled = createActionGate(actionConfig);

  if (reactionsActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Slack reactions are disabled.");
    }
    const channelId = readStringParam(params, "channelId", { required: true });
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Slack reaction.",
      });
      if (remove) {
        if (accountOpts) {
          await removeSlackReaction(channelId, messageId, emoji, accountOpts);
        } else {
          await removeSlackReaction(channelId, messageId, emoji);
        }
        return jsonResult({ ok: true, removed: emoji });
      }
      if (isEmpty) {
        const removed = accountOpts
          ? await removeOwnSlackReactions(channelId, messageId, accountOpts)
          : await removeOwnSlackReactions(channelId, messageId);
        return jsonResult({ ok: true, removed });
      }
      if (accountOpts) {
        await reactSlackMessage(channelId, messageId, emoji, accountOpts);
      } else {
        await reactSlackMessage(channelId, messageId, emoji);
      }
      return jsonResult({ ok: true, added: emoji });
    }
    const reactions = accountOpts
      ? await listSlackReactions(channelId, messageId, accountOpts)
      : await listSlackReactions(channelId, messageId);
    return jsonResult({ ok: true, reactions });
  }

  if (messagingActions.has(action)) {
    if (!isActionEnabled("messages")) {
      throw new Error("Slack messages are disabled.");
    }
    switch (action) {
      case "sendMessage": {
        const to = readStringParam(params, "to", { required: true });
        const content = readStringParam(params, "content", { required: true });
        const mediaUrl = readStringParam(params, "mediaUrl");
        const threadTs = resolveThreadTsFromContext(
          readStringParam(params, "threadTs"),
          to,
          context,
        );
        const result = await sendSlackMessage(to, content, {
          accountId: accountId ?? undefined,
          mediaUrl: mediaUrl ?? undefined,
          threadTs: threadTs ?? undefined,
        });

        // Keep "first" mode consistent even when the agent explicitly provided
        // threadTs: once we send a message to the current channel, consider the
        // first reply "used" so later tool calls don't auto-thread again.
        if (context?.hasRepliedRef && context.currentChannelId) {
          const normalizedTarget = to.startsWith("channel:")
            ? to.slice("channel:".length)
            : to;
          if (normalizedTarget === context.currentChannelId) {
            context.hasRepliedRef.value = true;
          }
        }

        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const channelId = readStringParam(params, "channelId", {
          required: true,
        });
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "content", {
          required: true,
        });
        if (accountOpts) {
          await editSlackMessage(channelId, messageId, content, accountOpts);
        } else {
          await editSlackMessage(channelId, messageId, content);
        }
        return jsonResult({ ok: true });
      }
      case "deleteMessage": {
        const channelId = readStringParam(params, "channelId", {
          required: true,
        });
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        if (accountOpts) {
          await deleteSlackMessage(channelId, messageId, accountOpts);
        } else {
          await deleteSlackMessage(channelId, messageId);
        }
        return jsonResult({ ok: true });
      }
      case "readMessages": {
        const channelId = readStringParam(params, "channelId", {
          required: true,
        });
        const limitRaw = params.limit;
        const limit =
          typeof limitRaw === "number" && Number.isFinite(limitRaw)
            ? limitRaw
            : undefined;
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const result = await readSlackMessages(channelId, {
          accountId: accountId ?? undefined,
          limit,
          before: before ?? undefined,
          after: after ?? undefined,
        });
        return jsonResult({ ok: true, ...result });
      }
      default:
        break;
    }
  }

  if (pinActions.has(action)) {
    if (!isActionEnabled("pins")) {
      throw new Error("Slack pins are disabled.");
    }
    const channelId = readStringParam(params, "channelId", { required: true });
    if (action === "pinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (accountOpts) {
        await pinSlackMessage(channelId, messageId, accountOpts);
      } else {
        await pinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    if (action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (accountOpts) {
        await unpinSlackMessage(channelId, messageId, accountOpts);
      } else {
        await unpinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    const pins = accountOpts
      ? await listSlackPins(channelId, accountOpts)
      : await listSlackPins(channelId);
    return jsonResult({ ok: true, pins });
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Slack member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    const info = accountOpts
      ? await getSlackMemberInfo(userId, accountOpts)
      : await getSlackMemberInfo(userId);
    return jsonResult({ ok: true, info });
  }

  if (action === "emojiList") {
    if (!isActionEnabled("emojiList")) {
      throw new Error("Slack emoji list is disabled.");
    }
    const emojis = accountOpts
      ? await listSlackEmojis(accountOpts)
      : await listSlackEmojis();
    return jsonResult({ ok: true, emojis });
  }

  throw new Error(`Unknown action: ${action}`);
}

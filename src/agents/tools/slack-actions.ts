import type { AgentToolResult } from "@mariozechner/pi-agent-core";

import type { MoltbotConfig } from "../../config/config.js";
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
import { parseSlackTarget, resolveSlackChannelId } from "../../slack/targets.js";
import { withNormalizedTimestamp } from "../date-time.js";
import { createActionGate, jsonResult, readReactionParams, readStringParam } from "./common.js";

const messagingActions = new Set(["sendMessage", "editMessage", "deleteMessage", "readMessages"]);

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

  const parsedTarget = parseSlackTarget(targetChannel, { defaultKind: "channel" });
  if (!parsedTarget || parsedTarget.kind !== "channel") return undefined;
  const normalizedTarget = parsedTarget.id;

  // Different channel - don't inject
  if (normalizedTarget !== context.currentChannelId) return undefined;

  // Check replyToMode
  if (context.replyToMode === "all") {
    return context.currentThreadTs;
  }
  if (context.replyToMode === "first" && context.hasRepliedRef && !context.hasRepliedRef.value) {
    context.hasRepliedRef.value = true;
    return context.currentThreadTs;
  }
  return undefined;
}

export async function handleSlackAction(
  params: Record<string, unknown>,
  cfg: MoltbotConfig,
  context?: SlackActionContext,
): Promise<AgentToolResult<unknown>> {
  const resolveChannelId = () =>
    resolveSlackChannelId(
      readStringParam(params, "channelId", {
        required: true,
      }),
    );
  const action = readStringParam(params, "action", { required: true });
  const accountId = readStringParam(params, "accountId");
  const account = resolveSlackAccount({ cfg, accountId });
  const actionConfig = account.actions ?? cfg.channels?.slack?.actions;
  const isActionEnabled = createActionGate(actionConfig);
  const userToken = account.config.userToken?.trim() || undefined;
  const botToken = account.botToken?.trim();
  const allowUserWrites = account.config.userTokenReadOnly === false;

  // Choose the most appropriate token for Slack read/write operations.
  const getTokenForOperation = (operation: "read" | "write") => {
    if (operation === "read") return userToken ?? botToken;
    if (!allowUserWrites) return botToken;
    return botToken ?? userToken;
  };

  const buildActionOpts = (operation: "read" | "write") => {
    const token = getTokenForOperation(operation);
    const tokenOverride = token && token !== botToken ? token : undefined;
    if (!accountId && !tokenOverride) return undefined;
    return {
      ...(accountId ? { accountId } : {}),
      ...(tokenOverride ? { token: tokenOverride } : {}),
    };
  };

  const readOpts = buildActionOpts("read");
  const writeOpts = buildActionOpts("write");

  if (reactionsActions.has(action)) {
    if (!isActionEnabled("reactions")) {
      throw new Error("Slack reactions are disabled.");
    }
    const channelId = resolveChannelId();
    const messageId = readStringParam(params, "messageId", { required: true });
    if (action === "react") {
      const { emoji, remove, isEmpty } = readReactionParams(params, {
        removeErrorMessage: "Emoji is required to remove a Slack reaction.",
      });
      if (remove) {
        if (writeOpts) {
          await removeSlackReaction(channelId, messageId, emoji, writeOpts);
        } else {
          await removeSlackReaction(channelId, messageId, emoji);
        }
        return jsonResult({ ok: true, removed: emoji });
      }
      if (isEmpty) {
        const removed = writeOpts
          ? await removeOwnSlackReactions(channelId, messageId, writeOpts)
          : await removeOwnSlackReactions(channelId, messageId);
        return jsonResult({ ok: true, removed });
      }
      if (writeOpts) {
        await reactSlackMessage(channelId, messageId, emoji, writeOpts);
      } else {
        await reactSlackMessage(channelId, messageId, emoji);
      }
      return jsonResult({ ok: true, added: emoji });
    }
    const reactions = readOpts
      ? await listSlackReactions(channelId, messageId, readOpts)
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
          ...writeOpts,
          mediaUrl: mediaUrl ?? undefined,
          threadTs: threadTs ?? undefined,
        });

        // Keep "first" mode consistent even when the agent explicitly provided
        // threadTs: once we send a message to the current channel, consider the
        // first reply "used" so later tool calls don't auto-thread again.
        if (context?.hasRepliedRef && context.currentChannelId) {
          const parsedTarget = parseSlackTarget(to, { defaultKind: "channel" });
          if (parsedTarget?.kind === "channel" && parsedTarget.id === context.currentChannelId) {
            context.hasRepliedRef.value = true;
          }
        }

        return jsonResult({ ok: true, result });
      }
      case "editMessage": {
        const channelId = resolveChannelId();
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        const content = readStringParam(params, "content", {
          required: true,
        });
        if (writeOpts) {
          await editSlackMessage(channelId, messageId, content, writeOpts);
        } else {
          await editSlackMessage(channelId, messageId, content);
        }
        return jsonResult({ ok: true });
      }
      case "deleteMessage": {
        const channelId = resolveChannelId();
        const messageId = readStringParam(params, "messageId", {
          required: true,
        });
        if (writeOpts) {
          await deleteSlackMessage(channelId, messageId, writeOpts);
        } else {
          await deleteSlackMessage(channelId, messageId);
        }
        return jsonResult({ ok: true });
      }
      case "readMessages": {
        const channelId = resolveChannelId();
        const limitRaw = params.limit;
        const limit =
          typeof limitRaw === "number" && Number.isFinite(limitRaw) ? limitRaw : undefined;
        const before = readStringParam(params, "before");
        const after = readStringParam(params, "after");
        const threadId = readStringParam(params, "threadId");
        const result = await readSlackMessages(channelId, {
          ...readOpts,
          limit,
          before: before ?? undefined,
          after: after ?? undefined,
          threadId: threadId ?? undefined,
        });
        const messages = result.messages.map((message) =>
          withNormalizedTimestamp(
            message as Record<string, unknown>,
            (message as { ts?: unknown }).ts,
          ),
        );
        return jsonResult({ ok: true, messages, hasMore: result.hasMore });
      }
      default:
        break;
    }
  }

  if (pinActions.has(action)) {
    if (!isActionEnabled("pins")) {
      throw new Error("Slack pins are disabled.");
    }
    const channelId = resolveChannelId();
    if (action === "pinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (writeOpts) {
        await pinSlackMessage(channelId, messageId, writeOpts);
      } else {
        await pinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    if (action === "unpinMessage") {
      const messageId = readStringParam(params, "messageId", {
        required: true,
      });
      if (writeOpts) {
        await unpinSlackMessage(channelId, messageId, writeOpts);
      } else {
        await unpinSlackMessage(channelId, messageId);
      }
      return jsonResult({ ok: true });
    }
    const pins = writeOpts
      ? await listSlackPins(channelId, readOpts)
      : await listSlackPins(channelId);
    const normalizedPins = pins.map((pin) => {
      const message = pin.message
        ? withNormalizedTimestamp(
            pin.message as Record<string, unknown>,
            (pin.message as { ts?: unknown }).ts,
          )
        : pin.message;
      return message ? { ...pin, message } : pin;
    });
    return jsonResult({ ok: true, pins: normalizedPins });
  }

  if (action === "memberInfo") {
    if (!isActionEnabled("memberInfo")) {
      throw new Error("Slack member info is disabled.");
    }
    const userId = readStringParam(params, "userId", { required: true });
    const info = writeOpts
      ? await getSlackMemberInfo(userId, readOpts)
      : await getSlackMemberInfo(userId);
    return jsonResult({ ok: true, info });
  }

  if (action === "emojiList") {
    if (!isActionEnabled("emojiList")) {
      throw new Error("Slack emoji list is disabled.");
    }
    const emojis = readOpts ? await listSlackEmojis(readOpts) : await listSlackEmojis();
    return jsonResult({ ok: true, emojis });
  }

  throw new Error(`Unknown action: ${action}`);
}

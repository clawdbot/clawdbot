// Feishu plugin module implements sequential key behavior.
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { normalizeFeishuCommandProbeBody } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";
import { isFeishuGroupChatType } from "./types.js";

export function getFeishuSequentialKey(params: {
  accountId: string;
  event: FeishuMessageEvent;
  botOpenId?: string;
  botName?: string;
}): string {
  const { accountId, event, botOpenId, botName } = params;
  const chatId = event.message.chat_id?.trim() || "unknown";
  const baseKey = `feishu:${accountId}:${chatId}`;
  const parsed = parseFeishuMessageEvent(event, botOpenId, botName);
  // Group and topic-group content keeps the bot's own <at> mention (see
  // #72504), so strip mention tags before classifying: otherwise a group
  // "@Bot /stop" or "@Bot /btw ..." no longer selects the :control / :btw
  // sequential lanes. In p2p the command owner keeps non-bot mentions for
  // mention forwarding, so stripping there would misclassify
  // "@Bot @Alice /stop" as a :control command even though dispatch treats it
  // as ordinary text.
  const isGroupChat = isFeishuGroupChatType(event.message.chat_type);
  const text = isGroupChat ? normalizeFeishuCommandProbeBody(parsed.content) : parsed.content;

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  return baseKey;
}

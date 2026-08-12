// Feishu plugin module implements sequential key behavior.
import {
  isAbortRequestText,
  isBtwRequestText,
} from "openclaw/plugin-sdk/command-primitives-runtime";
import { normalizeFeishuCommandProbeBody } from "./bot-content.js";
import { parseFeishuMessageEvent, type FeishuMessageEvent } from "./bot.js";

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
  // sequential lanes.
  const text = normalizeFeishuCommandProbeBody(parsed.content);

  if (isAbortRequestText(text)) {
    return `${baseKey}:control`;
  }

  if (isBtwRequestText(text)) {
    return `${baseKey}:btw`;
  }

  return baseKey;
}

import type { HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveTimestampMs } from "./format.js";
import type { DiscordMessagePreflightContext } from "./message-handler.preflight.types.js";
import { resolveDiscordMessageText } from "./message-utils.js";

export function buildDiscordPreflightHistoryEntry(params: {
  isGuildMessage: boolean;
  historyLimit: number;
  message: DiscordMessagePreflightContext["message"];
  senderLabel: string;
}): HistoryEntry | undefined {
  const textForHistory = resolveDiscordMessageText(params.message, {
    includeForwarded: true,
  });
  return params.isGuildMessage && params.historyLimit > 0 && textForHistory
    ? {
        sender: params.senderLabel,
        body: textForHistory,
        timestamp: resolveTimestampMs(params.message.timestamp),
        messageId: params.message.id,
      }
    : undefined;
}

import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { parseTelegramTarget } from "./targets.js";

export function resolveTelegramAutoThreadId(params: {
  to: string;
  toolContext?: { currentThreadTs?: string; currentChannelId?: string };
}): string | undefined {
  const context = params.toolContext;
  if (!context?.currentThreadTs || !context.currentChannelId) {
    return undefined;
  }
  const parsedTo = parseTelegramTarget(params.to);
  if (parsedTo.messageThreadId != null) {
    return undefined;
  }
  const parsedChannel = parseTelegramTarget(context.currentChannelId);
  if (
    normalizeLowercaseStringOrEmpty(parsedTo.chatId) !==
    normalizeLowercaseStringOrEmpty(parsedChannel.chatId)
  ) {
    return undefined;
  }
  return context.currentThreadTs;
}

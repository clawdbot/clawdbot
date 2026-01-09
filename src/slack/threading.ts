import type { ReplyToMode } from "../config/types.js";
import type { SlackAppMentionEvent, SlackMessageEvent } from "./types.js";

export function resolveSlackThreadTargets(params: {
  message: SlackMessageEvent | SlackAppMentionEvent;
  replyToMode: ReplyToMode;
}) {
  const incomingThreadTs = params.message.thread_ts;
  const eventTs = params.message.event_ts;
  const messageTs = params.message.ts ?? eventTs;
  const replyThreadTs =
    incomingThreadTs ?? (params.replyToMode === "all" ? messageTs : undefined);
  const statusThreadTs = replyThreadTs ?? messageTs;
  return { replyThreadTs, statusThreadTs };
}

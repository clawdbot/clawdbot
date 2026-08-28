import {
  isSilentReplyText,
  SILENT_REPLY_TOKEN,
  startsWithSilentToken,
  stripLeadingSilentToken,
  stripSilentToken,
} from "../auto-reply/tokens.js";
import { logWarn } from "../logger.js";
import { isCronSessionKey } from "../sessions/session-key-utils.js";
import { isAnnounceSkip } from "./tools/sessions-send-tokens.js";

export function normalizeSubagentAnnounceReply(text: string): string | null {
  let result = text;
  let didStrip = false;
  const hasLeadingSilentToken = startsWithSilentToken(result, SILENT_REPLY_TOKEN);
  if (hasLeadingSilentToken) {
    result = stripLeadingSilentToken(result, SILENT_REPLY_TOKEN);
    didStrip = true;
  }
  if (hasLeadingSilentToken || result.toLowerCase().includes(SILENT_REPLY_TOKEN.toLowerCase())) {
    result = stripSilentToken(result, SILENT_REPLY_TOKEN);
    didStrip = true;
  }
  if (
    didStrip &&
    (!result.trim() || isSilentReplyText(result, SILENT_REPLY_TOKEN) || isAnnounceSkip(result))
  ) {
    return null;
  }
  return result;
}

export function warnIfCronAnnounceSkipped(params: {
  reply: string | undefined;
  requesterSessionKey: string;
  childRunId: string;
}): void {
  if (!isAnnounceSkip(params.reply) || !isCronSessionKey(params.requesterSessionKey)) {
    return;
  }
  logWarn(
    `cron job completion for session=${params.requesterSessionKey} ` +
      `run=${params.childRunId} suppressed by ANNOUNCE_SKIP; ` +
      `the agent replied with the skip sentinel instead of delivering a result`,
  );
}

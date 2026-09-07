import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createReplyTimingTracker } from "./reply-timing-tracker.js";

type ReplyHotPathLogContext = {
  channel: string;
  messageId?: number | string;
  sessionKey?: string;
};
type ReplyHotPathLogParams = ReplyHotPathLogContext & {
  outcome: "completed" | "skipped" | "error";
  reason?: string;
};

const replyHotPathTimingLog = createSubsystemLogger("auto-reply/reply-timing");

export function createReplyHotPathTimingTracker(options: { profilerEnabled?: boolean } = {}) {
  const timing = createReplyTimingTracker<
    ReplyHotPathLogParams | (ReplyHotPathLogContext & { outcome: "milestone"; reason: string })
  >({
    log: replyHotPathTimingLog,
    enabled: options.profilerEnabled === true,
    formatMessage: (params, summary, stages) =>
      `reply hot path timings channel=${params.channel} messageId=${params.messageId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} totalMs=${summary.totalMs} stages=${stages}${params.reason ? ` reason=${params.reason}` : ""}`,
    detailKeys: () => ["channel", "messageId", "sessionKey", "outcome", "reason"],
  });
  return {
    measure: timing.measure,
    logIfSlow(params: ReplyHotPathLogParams) {
      if (!options.profilerEnabled) {
        return;
      }
      timing.logIfSlow(params);
    },
    logPreparationIfSlow(params: ReplyHotPathLogContext) {
      const { channel, messageId, sessionKey } = params;
      timing.logIfSlow(
        { channel, messageId, sessionKey, outcome: "milestone", reason: "before_reply_resolver" },
        { repeat: true },
      );
    },
  };
}

import { createSubsystemLogger } from "../../logging/subsystem.js";
import { createReplyTimingTracker } from "./reply-timing-tracker.js";

type ReplyHotPathLogParams = {
  channel: string;
  messageId?: number | string;
  sessionKey?: string;
  outcome: "completed" | "skipped" | "error";
  reason?: string;
};

const replyHotPathTimingLog = createSubsystemLogger("auto-reply/reply-timing");

export function createReplyHotPathTimingTracker(options: { profilerEnabled?: boolean } = {}) {
  const timing = createReplyTimingTracker<ReplyHotPathLogParams>({
    log: replyHotPathTimingLog,
    enabled: options.profilerEnabled === true,
    formatMessage: (params, summary, stages) =>
      `reply hot path timings channel=${params.channel} messageId=${params.messageId ?? "unknown"} sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} totalMs=${summary.totalMs} stages=${stages}${params.reason ? ` reason=${params.reason}` : ""}`,
    detailKeys: () => ["channel", "messageId", "sessionKey", "outcome", "reason"],
  });
  return {
    measure: timing.measure,
    logIfSlow(params: ReplyHotPathLogParams) {
      timing.logIfSlow(params);
    },
  };
}

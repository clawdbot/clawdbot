import { createSubsystemLogger } from "../../logging/subsystem.js";

type ReplyHotPathTimingSpan = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

type ReplyHotPathTimingSummary = {
  totalMs: number;
  spans: ReplyHotPathTimingSpan[];
};

const replyHotPathTimingLog = createSubsystemLogger("auto-reply/reply-timing");
const REPLY_HOT_PATH_TIMING_WARN_TOTAL_MS = 1_000;
const REPLY_HOT_PATH_TIMING_WARN_STAGE_MS = 500;

export function createReplyHotPathTimingTracker(options: { profilerEnabled?: boolean } = {}): {
  measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  logIfSlow: (params: {
    channel: string;
    messageId?: number | string;
    sessionKey?: string;
    outcome: "completed" | "skipped" | "error";
    reason?: string;
  }) => void;
} {
  if (!options.profilerEnabled) {
    // This slow-path splitter was added for latency investigation. Keep it
    // inert in normal production dispatches so only explicit profiler runs pay
    // the Date.now/span allocation cost.
    return {
      async measure(_name, run) {
        return await run();
      },
      logIfSlow() {},
    };
  }

  const startedAt = Date.now();
  let didLog = false;
  const spans: ReplyHotPathTimingSpan[] = [];
  const toMs = (value: number) => Math.max(0, Math.round(value));
  const snapshot = (): ReplyHotPathTimingSummary => ({
    totalMs: toMs(Date.now() - startedAt),
    spans: spans.slice(),
  });
  const shouldLog = (summary: ReplyHotPathTimingSummary) =>
    summary.totalMs >= REPLY_HOT_PATH_TIMING_WARN_TOTAL_MS ||
    summary.spans.some((span) => span.durationMs >= REPLY_HOT_PATH_TIMING_WARN_STAGE_MS);
  const formatSpans = (summary: ReplyHotPathTimingSummary) =>
    summary.spans.length > 0
      ? summary.spans
          .map((span) => `${span.name}:${span.durationMs}ms@${span.elapsedMs}ms`)
          .join(",")
      : "none";
  return {
    async measure(name, run) {
      const spanStartedAt = Date.now();
      try {
        return await run();
      } finally {
        spans.push({
          name,
          durationMs: toMs(Date.now() - spanStartedAt),
          elapsedMs: toMs(Date.now() - startedAt),
        });
      }
    },
    logIfSlow(params) {
      if (didLog) {
        return;
      }
      const summary = snapshot();
      if (!shouldLog(summary)) {
        return;
      }
      didLog = true;
      replyHotPathTimingLog.warn(
        `reply hot path timings channel=${params.channel} messageId=${
          params.messageId ?? "unknown"
        } sessionKey=${params.sessionKey ?? "unknown"} outcome=${params.outcome} totalMs=${
          summary.totalMs
        } stages=${formatSpans(summary)}${params.reason ? ` reason=${params.reason}` : ""}`,
        {
          channel: params.channel,
          messageId: params.messageId,
          sessionKey: params.sessionKey,
          outcome: params.outcome,
          reason: params.reason,
          totalMs: summary.totalMs,
          spans: summary.spans,
        },
      );
    },
  };
}

import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createStageTimingTracker,
  formatStageTimings,
  type StageTiming,
} from "openclaw/plugin-sdk/time-runtime";

type CodexThreadLifecycleTimingSummary = {
  totalMs: number;
  spans: StageTiming[];
};

type CodexThreadLifecycleTimingLogger = {
  isEnabled?: (level: "trace") => boolean;
  trace: (message: string, meta?: Record<string, unknown>) => void;
  warn: (message: string, meta?: Record<string, unknown>) => void;
};

type CodexThreadLifecycleTimingAction = "started" | "resumed" | "forked" | "rotated";

export type CodexThreadLifecycleTimingOptions = {
  enabled?: boolean;
  now?: () => number;
  log?: CodexThreadLifecycleTimingLogger;
  totalThresholdMs?: number;
  stageThresholdMs?: number;
};

export type CodexThreadLifecycleTimingTracker = {
  measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  measureSync: <T>(name: string, run: () => T) => T;
  mark: (name: string) => void;
  logSummary: (params: {
    runId: string;
    sessionId: string;
    sessionKey?: string;
    action: CodexThreadLifecycleTimingAction;
    threadId?: string;
  }) => void;
};

const CODEX_THREAD_LIFECYCLE_TIMING_WARN_TOTAL_MS = 1_000;
const CODEX_THREAD_LIFECYCLE_TIMING_WARN_STAGE_MS = 500;

function shouldWarnCodexThreadLifecycleTimingSummary(
  summary: CodexThreadLifecycleTimingSummary,
  options: CodexThreadLifecycleTimingOptions = {},
): boolean {
  const detailed = options.enabled || options.log?.isEnabled?.("trace");
  const totalThresholdMs =
    options.totalThresholdMs ?? (detailed ? CODEX_THREAD_LIFECYCLE_TIMING_WARN_TOTAL_MS : 10_000);
  const stageThresholdMs =
    options.stageThresholdMs ?? (detailed ? CODEX_THREAD_LIFECYCLE_TIMING_WARN_STAGE_MS : 5_000);
  return (
    summary.totalMs >= totalThresholdMs ||
    summary.spans.some((span) => span.durationMs >= stageThresholdMs)
  );
}

function formatCodexThreadLifecycleTimingSummary(params: {
  runId: string;
  sessionId: string;
  sessionKey?: string;
  action: CodexThreadLifecycleTimingAction;
  summary: CodexThreadLifecycleTimingSummary;
}): string {
  const spans = formatStageTimings(params.summary.spans);
  return (
    `[trace:codex-app-server] thread lifecycle: runId=${params.runId} ` +
    `sessionId=${params.sessionId} sessionKey=${params.sessionKey ?? "unknown"} ` +
    `action=${params.action} totalMs=${params.summary.totalMs} stages=${spans}`
  );
}

export function createCodexThreadLifecycleTimingTracker(
  options: CodexThreadLifecycleTimingOptions = {},
): CodexThreadLifecycleTimingTracker {
  const log = options.log ?? embeddedAgentLog;

  const timing = createStageTimingTracker(options.now ?? Date.now);
  let didLog = false;
  return {
    measure: timing.measure,
    measureSync: timing.measureSync,
    mark(name) {
      // Lifecycle marks are instantaneous spans, not time since the previous mark.
      timing.measureSync(name, () => undefined);
    },
    logSummary(params) {
      if (didLog) {
        return;
      }
      const { totalMs, stages: spans } = timing.snapshot();
      const summary = { totalMs, spans };
      const shouldWarn = shouldWarnCodexThreadLifecycleTimingSummary(summary, { ...options, log });
      if (!shouldWarn && !log.isEnabled?.("trace")) {
        return;
      }
      didLog = true;
      const message = formatCodexThreadLifecycleTimingSummary({
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        action: params.action,
        summary,
      });
      const meta = {
        runId: params.runId,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        action: params.action,
        threadId: params.threadId,
        totalMs: summary.totalMs,
        spans: summary.spans,
      };
      if (shouldWarn) {
        log.warn(message, meta);
      } else {
        log.trace(message, meta);
      }
    },
  };
}

/** Lightweight reply-stage profiler for slow-turn diagnostics. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";

type ReplyTimingSpan = {
  name: string;
  durationMs: number;
  elapsedMs: number;
};

type ReplyTimingSummary = {
  totalMs: number;
  spans: ReplyTimingSpan[];
};

type ReplyTimingLogger = {
  warn: (message: string, details?: Record<string, unknown>) => void;
};

type ReplyTimingTracker = {
  measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  measureSync: <T>(name: string, run: () => T) => T;
  logIfSlow: (params: {
    message: string;
    outcome?: string;
    reason?: string;
    error?: string;
    details?: Record<string, unknown>;
  }) => void;
};

const DEFAULT_TIMING_WARN_TOTAL_MS = 1_000;
const DEFAULT_TIMING_WARN_STAGE_MS = 500;

/** Checks config/env diagnostic flags for reply profiling. */
export function isReplyProfilerEnabled(params?: {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const cfg = params?.config;
  const env = params?.env ?? process.env;
  return (
    isDiagnosticFlagEnabled("profiler", cfg, env) ||
    isDiagnosticFlagEnabled("reply.profiler", cfg, env)
  );
}

/** Creates a lightweight timing tracker for slow reply-stage diagnostics. */
export function createReplyTimingTracker(params: {
  log: ReplyTimingLogger;
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  enabled?: boolean;
  totalWarnMs?: number;
  stageWarnMs?: number;
}): ReplyTimingTracker {
  const enabled =
    params.enabled ?? isReplyProfilerEnabled({ config: params.config, env: params.env });
  if (!enabled) {
    // Normal production turns use pass-through wrappers so added profiling
    // calls do not allocate spans or call Date.now on the hot reply path.
    return {
      async measure(_name, run) {
        return await run();
      },
      measureSync(_name, run) {
        return run();
      },
      logIfSlow() {},
    };
  }

  const startedAt = Date.now();
  const spans: ReplyTimingSpan[] = [];
  let didLog = false;
  const totalWarnMs = params.totalWarnMs ?? DEFAULT_TIMING_WARN_TOTAL_MS;
  const stageWarnMs = params.stageWarnMs ?? DEFAULT_TIMING_WARN_STAGE_MS;
  const toMs = (value: number) => Math.max(0, Math.round(value));
  const record = (name: string, spanStartedAt: number) => {
    spans.push({
      name,
      durationMs: toMs(Date.now() - spanStartedAt),
      elapsedMs: toMs(Date.now() - startedAt),
    });
  };
  const snapshot = (): ReplyTimingSummary => ({
    totalMs: toMs(Date.now() - startedAt),
    spans: spans.slice(),
  });
  const shouldLog = (summary: ReplyTimingSummary) =>
    summary.totalMs >= totalWarnMs || summary.spans.some((span) => span.durationMs >= stageWarnMs);
  const formatSpans = (summary: ReplyTimingSummary) =>
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
        record(name, spanStartedAt);
      }
    },
    measureSync(name, run) {
      const spanStartedAt = Date.now();
      try {
        return run();
      } finally {
        record(name, spanStartedAt);
      }
    },
    logIfSlow(logParams) {
      if (didLog) {
        return;
      }
      const summary = snapshot();
      if (!shouldLog(summary)) {
        return;
      }
      didLog = true;
      const suffix = [
        `totalMs=${summary.totalMs}`,
        `stages=${formatSpans(summary)}`,
        logParams.outcome ? `outcome=${logParams.outcome}` : undefined,
        logParams.reason ? `reason=${logParams.reason}` : undefined,
        logParams.error ? `error="${logParams.error}"` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      params.log.warn(`${logParams.message} ${suffix}`, {
        ...logParams.details,
        outcome: logParams.outcome,
        reason: logParams.reason,
        error: logParams.error,
        totalMs: summary.totalMs,
        spans: summary.spans,
      });
    },
  };
}

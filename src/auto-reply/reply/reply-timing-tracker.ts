/** Lightweight reply-stage profiler for slow-turn diagnostics. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";

type ReplyTimingSummary = {
  totalMs: number;
  spans: Array<{ name: string; durationMs: number; elapsedMs: number }>;
};

type ReplyTimingLogParams = {
  message: string;
  outcome?: string;
  reason?: string;
  error?: string;
  details?: Record<string, unknown>;
};

type ReplyTimingTracker<TLogParams extends object = ReplyTimingLogParams> = {
  measure: <T>(name: string, run: () => Promise<T> | T) => Promise<T>;
  measureSync: <T>(name: string, run: () => T) => T;
  logIfSlow: (params: TLogParams, options?: { repeat?: boolean }) => void;
};

const disabledTimingTracker: ReplyTimingTracker<object> = {
  async measure(_name, run) {
    return await run();
  },
  measureSync(_name, run) {
    return run();
  },
  logIfSlow() {},
};

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

/** Creates a no-timer pass-through unless reply profiling is enabled. */
export function createReplyTimingTracker<TLogParams extends object = ReplyTimingLogParams>(params: {
  log: { warn: (message: string, details?: Record<string, unknown>) => void };
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  enabled?: boolean;
  totalWarnMs?: number;
  stageWarnMs?: number;
  formatMessage?: (
    params: TLogParams,
    summary: ReplyTimingSummary,
    formattedSpans: string,
  ) => string;
  detailKeys?: (params: TLogParams) => readonly string[];
}): ReplyTimingTracker<TLogParams> {
  const enabled =
    params.enabled ?? isReplyProfilerEnabled({ config: params.config, env: params.env });
  if (!enabled) {
    // Normal turns share this pass-through, avoiding Date.now and span arrays.
    return disabledTimingTracker as ReplyTimingTracker<TLogParams>;
  }

  const startedAt = Date.now();
  const spans: ReplyTimingSummary["spans"] = [];
  let didLog = false;
  const totalWarnMs = params.totalWarnMs ?? 1_000;
  const stageWarnMs = params.stageWarnMs ?? 500;
  const toMs = (value: number) => Math.max(0, Math.round(value));
  const record = (name: string, spanStartedAt: number) => {
    spans.push({
      name,
      durationMs: toMs(Date.now() - spanStartedAt),
      elapsedMs: toMs(Date.now() - startedAt),
    });
  };

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
    logIfSlow(logParams, options) {
      if (didLog && !options?.repeat) {
        return;
      }
      const summary = { totalMs: toMs(Date.now() - startedAt), spans: spans.slice() };
      if (
        summary.totalMs < totalWarnMs &&
        !summary.spans.some((span) => span.durationMs >= stageWarnMs)
      ) {
        return;
      }
      if (!options?.repeat) {
        didLog = true;
      }
      const formattedSpans =
        summary.spans.length > 0
          ? summary.spans
              .map((span) => `${span.name}:${span.durationMs}ms@${span.elapsedMs}ms`)
              .join(",")
          : "none";
      if (params.formatMessage) {
        const detailParams = logParams as Record<string, unknown>;
        const details = Object.fromEntries(
          (params.detailKeys?.(logParams) ?? []).map((key) => [key, detailParams[key]]),
        );
        params.log.warn(params.formatMessage(logParams, summary, formattedSpans), {
          ...details,
          totalMs: summary.totalMs,
          spans: summary.spans,
        });
        return;
      }
      const defaults = logParams as ReplyTimingLogParams;
      const suffix = [
        `totalMs=${summary.totalMs}`,
        `stages=${formattedSpans}`,
        defaults.outcome ? `outcome=${defaults.outcome}` : undefined,
        defaults.reason ? `reason=${defaults.reason}` : undefined,
        defaults.error ? `error="${defaults.error}"` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      params.log.warn(`${defaults.message} ${suffix}`, {
        ...defaults.details,
        outcome: defaults.outcome,
        reason: defaults.reason,
        error: defaults.error,
        totalMs: summary.totalMs,
        spans: summary.spans,
      });
    },
  };
}

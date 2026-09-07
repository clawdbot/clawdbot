/** Lightweight reply-stage profiler for slow-turn diagnostics. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isDiagnosticFlagEnabled } from "../../infra/diagnostic-flags.js";
import {
  createStageTimingTracker,
  formatStageTimings,
  type StageTiming,
} from "../../shared/stage-timing.js";

type ReplyTimingSummary = {
  totalMs: number;
  spans: StageTiming[];
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

/** Keeps slow replies diagnosable; profiling lowers the warning thresholds. */
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
  const profilerEnabled =
    params.enabled ?? isReplyProfilerEnabled({ config: params.config, env: params.env });
  const timing = createStageTimingTracker();
  let didLog = false;
  const totalWarnMs = params.totalWarnMs ?? (profilerEnabled ? 1_000 : 10_000);
  const stageWarnMs = params.stageWarnMs ?? (profilerEnabled ? 500 : 5_000);
  return {
    measure: timing.measure,
    measureSync: timing.measureSync,
    logIfSlow(logParams, options) {
      if (didLog && !options?.repeat) {
        return;
      }
      const { totalMs, stages: spans } = timing.snapshot();
      const summary = { totalMs, spans };
      if (
        summary.totalMs < totalWarnMs &&
        !summary.spans.some((span) => span.durationMs >= stageWarnMs)
      ) {
        return;
      }
      if (!options?.repeat) {
        didLog = true;
      }
      const formattedSpans = formatStageTimings(summary.spans);
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

import { isMainThread, threadId } from "node:worker_threads";
import {
  createStageTimingTracker,
  formatStageTimings,
  type StageTimingSummary,
} from "../../../shared/stage-timing.js";

type EmbeddedRunStageSummary = StageTimingSummary;

/** Lightweight monotonic-ish stage tracker used for embedded run startup diagnostics. */
type EmbeddedRunStageTracker = {
  mark: (name: string) => void;
  snapshot: () => EmbeddedRunStageSummary;
};

/** Canonical stage names for dispatch-time embedded attempt diagnostics. */
export const EMBEDDED_RUN_ATTEMPT_DISPATCH_STAGE = {
  workspace: "attempt-workspace",
  prompt: "attempt-prompt",
  runtimePlan: "attempt-runtime-plan",
  dispatch: "attempt-dispatch",
} as const;

const EMBEDDED_RUN_STAGE_WARN_TOTAL_MS = 10_000;
const EMBEDDED_RUN_STAGE_WARN_STAGE_MS = 5_000;

/**
 * Creates an append-only stage tracker. `mark` records time since the previous
 * mark while `snapshot` reports current total elapsed time without mutating the
 * recorded stage list.
 */
export function createEmbeddedRunStageTracker(options?: {
  now?: () => number;
}): EmbeddedRunStageTracker {
  const { mark, snapshot } = createStageTimingTracker(options?.now ?? Date.now);
  return { mark, snapshot };
}

/** Returns true when either total runtime or any single stage exceeds warning thresholds. */
export function shouldWarnEmbeddedRunStageSummary(
  summary: EmbeddedRunStageSummary,
  options?: {
    totalThresholdMs?: number;
    stageThresholdMs?: number;
  },
): boolean {
  const totalThresholdMs = options?.totalThresholdMs ?? EMBEDDED_RUN_STAGE_WARN_TOTAL_MS;
  const stageThresholdMs = options?.stageThresholdMs ?? EMBEDDED_RUN_STAGE_WARN_STAGE_MS;
  return (
    summary.totalMs >= totalThresholdMs ||
    summary.stages.some((stage) => stage.durationMs >= stageThresholdMs)
  );
}

/**
 * Builds the shared "emit stage summary" closure used by run startup and
 * attempt prep: warn when thresholds trip, trace otherwise, stay silent when
 * neither applies.
 */
export function createEmbeddedRunStageSummaryEmitter(options: {
  label: string;
  log: {
    isEnabled: (level: "trace") => boolean;
    warn: (message: string) => void;
    trace: (message: string) => void;
  };
  runId: string;
  sessionId?: string;
  tracker: EmbeddedRunStageTracker;
}): (phase: string) => void {
  return (phase) => {
    const summary = options.tracker.snapshot();
    const shouldWarn = shouldWarnEmbeddedRunStageSummary(summary);
    if (!shouldWarn && !options.log.isEnabled("trace")) {
      return;
    }
    const message = formatEmbeddedRunStageSummary(
      `[trace:embedded-run] ${options.label}: runId=${options.runId} sessionId=${options.sessionId} phase=${phase}`,
      summary,
    );
    if (shouldWarn) {
      options.log.warn(message);
    } else {
      options.log.trace(message);
    }
  };
}

/** Formats stage timing into compact log text for startup/attempt diagnostics. */
export function formatEmbeddedRunStageSummary(
  prefix: string,
  summary: EmbeddedRunStageSummary,
): string {
  const stages = formatStageTimings(summary.stages);
  return `${prefix} pid=${process.pid} threadId=${threadId} isMainThread=${isMainThread} totalMs=${summary.totalMs} stages=${stages}`;
}

// Health check runner types describe execution state for doctor health checks.
import type {
  HealthCheck,
  HealthCheckContext,
  HealthCheckScope,
  HealthFinding,
  HealthRepairDiff,
  HealthRepairEffect,
  HealthRepairResult,
} from "./health-checks.js";

// Runnable health-check contracts used by doctor lint/fix orchestration.
export interface HealthCheckRunContext extends HealthCheckContext {
  readonly repair: boolean;
  readonly diff?: boolean;
  readonly previewRepair?: boolean;
}

/** Result shape for checks that combine detect, preview, and repair in one run() method. */
export interface HealthCheckRunResult extends Omit<HealthRepairResult, "changes" | "status"> {
  readonly findings?: readonly HealthFinding[];
  readonly status?: "repairable" | "repaired" | "skipped" | "failed";
  readonly changes?: readonly string[];
  readonly diffs?: readonly HealthRepairDiff[];
  readonly effects?: readonly HealthRepairEffect[];
}

/** Health-check implementation that owns its own detect/repair orchestration. */
export interface RunnableHealthCheck extends Pick<
  HealthCheck,
  "id" | "kind" | "description" | "source"
> {
  run(ctx: HealthCheckRunContext, scope?: HealthCheckScope): Promise<HealthCheckRunResult>;
}

export type HealthCheckInput = HealthCheck | RunnableHealthCheck;

/** Normalized check contract consumed by lint and repair runners. */
export interface RegisteredHealthCheck extends HealthCheck {
  readonly sourceContract: "split" | "run";
  run(ctx: HealthCheckRunContext, scope?: HealthCheckScope): Promise<HealthCheckRunResult>;
}

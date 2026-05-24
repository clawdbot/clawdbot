import type {
  HealthCheck,
  HealthCheckContext,
  HealthCheckScope,
  HealthFinding,
  HealthRepairDiff,
  HealthRepairEffect,
  HealthRepairResult,
} from "./health-checks.js";

export interface HealthCheckRunContext extends HealthCheckContext {
  readonly repair: boolean;
  readonly diff?: boolean;
  readonly previewRepair?: boolean;
}

export interface HealthCheckRunResult extends Omit<HealthRepairResult, "changes" | "status"> {
  readonly findings?: readonly HealthFinding[];
  readonly status?: "repairable" | "repaired" | "skipped" | "failed";
  readonly changes?: readonly string[];
  readonly diffs?: readonly HealthRepairDiff[];
  readonly effects?: readonly HealthRepairEffect[];
}

export interface RunnableHealthCheck extends Pick<
  HealthCheck,
  "id" | "kind" | "description" | "source"
> {
  run(ctx: HealthCheckRunContext, scope?: HealthCheckScope): Promise<HealthCheckRunResult>;
}

export type HealthCheckInput = HealthCheck | RunnableHealthCheck;

export interface RegisteredHealthCheck extends HealthCheck {
  readonly sourceContract: "split" | "run";
  run(ctx: HealthCheckRunContext, scope?: HealthCheckScope): Promise<HealthCheckRunResult>;
}

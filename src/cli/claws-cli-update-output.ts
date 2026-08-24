import type { ClawUpdatePlan } from "../claws/update-plan.js";
import type { RuntimeEnv } from "../runtime.js";
import { renderClawUpdatePlanSummary } from "./claws-plan-render.js";

export function logClawUpdatePlanSummary(plan: ClawUpdatePlan, runtime: RuntimeEnv): void {
  const render = renderClawUpdatePlanSummary(plan);
  for (const line of render.lines) {
    runtime.log(line);
  }
  for (const error of render.errors) {
    runtime.error(error);
  }
}

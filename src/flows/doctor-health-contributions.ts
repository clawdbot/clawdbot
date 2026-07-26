import { runStructuredHealthRepairs } from "./doctor-health-contribution-core.js";
import type {
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
// Doctor health contributions preserve the ordered interactive doctor flow while
// exposing the same checks to structured lint and repair commands.
import { createDoctorHealthContribution } from "./doctor-health-contribution.js";
import { resolveFinalDoctorHealthContributions } from "./doctor-health-contributions-final.js";
import { resolveInitialDoctorHealthContributions } from "./doctor-health-contributions-initial.js";
import { normalizeHealthCheck } from "./health-check-adapter.js";
import type { HealthCheck } from "./health-checks.js";

export type { DoctorHealthFlowContext } from "./doctor-health-contribution-types.js";

function resolveDoctorHealthContributions(): DoctorHealthContribution[] {
  return [
    ...resolveInitialDoctorHealthContributions({
      runStructuredHealthRepairs: (ctx) =>
        runStructuredHealthRepairs(ctx, resolveDoctorContributionHealthChecks),
    }),
    ...resolveFinalDoctorHealthContributions(),
  ];
}

export async function resolveDoctorContributionHealthChecks(): Promise<readonly HealthCheck[]> {
  const { createCoreHealthChecks } = await import("./doctor-core-checks.js");
  const checksById = new Map(createCoreHealthChecks().map((check) => [check.id, check]));
  const checks: HealthCheck[] = [];
  for (const contribution of resolveDoctorHealthContributions()) {
    if (contribution.healthChecks.length > 0) {
      checks.push(...contribution.healthChecks.map(normalizeHealthCheck));
      continue;
    }
    for (const id of contribution.healthCheckIds) {
      const check = checksById.get(id);
      if (check === undefined) {
        throw new Error(
          `doctor contribution ${contribution.id} references unknown core health check ${id}`,
        );
      }
      checks.push(check);
    }
  }
  return checks;
}

export async function runDoctorHealthContributions(ctx: DoctorHealthFlowContext): Promise<void> {
  for (const contribution of resolveDoctorHealthContributions()) {
    await contribution.run(ctx);
  }
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.doctorHealthContributionsTestApi")
  ] = { createDoctorHealthContribution, resolveDoctorHealthContributions };
}

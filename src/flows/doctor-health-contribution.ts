import type {
  DoctorContributionHealthCheck,
  DoctorHealthContribution,
  DoctorHealthFlowContext,
} from "./doctor-health-contribution-types.js";
import type { HealthCheckInput } from "./health-check-runner-types.js";
import type { HealthFinding } from "./health-checks.js";

export function createDoctorHealthContribution(params: {
  id: string;
  label: string;
  healthCheckIds?: readonly string[];
  healthChecks?: DoctorContributionHealthCheck | readonly DoctorContributionHealthCheck[];
  hint?: string;
  run?: (ctx: DoctorHealthFlowContext) => Promise<void>;
}): DoctorHealthContribution {
  const healthChecks = normalizeHealthChecks(params.id, params.healthChecks);
  const healthCheckIds = params.healthCheckIds ?? healthChecks.map((check) => check.id);
  if (params.run === undefined && healthChecks.length === 0) {
    throw new Error(`doctor contribution ${params.id} must define run or healthChecks`);
  }
  return {
    id: params.id,
    kind: "core",
    surface: "health",
    option: {
      value: params.id,
      label: params.label,
      ...(params.hint ? { hint: params.hint } : {}),
    },
    source: "doctor",
    healthChecks,
    healthCheckIds,
    run:
      params.run ??
      ((ctx) =>
        runStructuredDoctorHealthContribution({
          contributionId: params.id,
          ctx,
          checks: healthChecks,
        })),
  };
}

function normalizeHealthChecks(
  contributionId: string,
  healthChecks?: DoctorContributionHealthCheck | readonly DoctorContributionHealthCheck[],
): readonly HealthCheckInput[] {
  if (healthChecks === undefined) {
    return [];
  }
  const checks = Array.isArray(healthChecks) ? healthChecks : [healthChecks];
  return checks.map((check) =>
    normalizeContributionHealthCheck(check, contributionId, checks.length),
  );
}

function normalizeContributionHealthCheck(
  check: DoctorContributionHealthCheck,
  contributionId: string,
  count: number,
): HealthCheckInput {
  const id = check.id ?? (count === 1 ? deriveCoreHealthCheckId(contributionId) : undefined);
  if (id === undefined) {
    throw new Error(
      `doctor contribution ${contributionId} must specify health check ids when it declares multiple healthChecks`,
    );
  }
  return {
    ...check,
    id,
    kind: check.kind ?? "core",
    source: check.source ?? "doctor",
  };
}

function deriveCoreHealthCheckId(contributionId: string): string {
  return contributionId.startsWith("doctor:")
    ? `core/doctor/${contributionId.slice("doctor:".length)}`
    : `core/doctor/${contributionId}`;
}

async function runStructuredDoctorHealthContribution(params: {
  contributionId: string;
  ctx: DoctorHealthFlowContext;
  checks: readonly HealthCheckInput[];
}): Promise<void> {
  if (params.checks.length === 0) {
    throw new Error(`doctor contribution ${params.contributionId} has no structured health`);
  }
  const { runDoctorHealthRepairs } = await import("./doctor-repair-flow.js");
  const { resolveAgentWorkspaceDir, resolveDefaultAgentId } =
    await import("../agents/agent-scope.js");
  const workspaceDir = resolveAgentWorkspaceDir(
    params.ctx.cfg,
    resolveDefaultAgentId(params.ctx.cfg),
  );
  const dryRun = !params.ctx.prompter.shouldRepair;
  const result = await runDoctorHealthRepairs(
    {
      mode: "fix",
      runtime: params.ctx.runtime,
      cfg: params.ctx.cfg,
      cwd: workspaceDir,
      configPath: params.ctx.configPath,
      dryRun,
      allowExecSecretRefs: params.ctx.options.allowExec === true,
    },
    { checks: params.checks, dryRun },
  );
  params.ctx.cfg = result.config;
  renderStructuredHealthFindings(params.ctx, result.findings);
  for (const warning of result.warnings) {
    params.ctx.runtime.error(warning);
  }
  for (const change of result.changes) {
    params.ctx.runtime.log(change);
  }
}

export function renderStructuredHealthFindings(
  ctx: DoctorHealthFlowContext,
  findings: readonly HealthFinding[],
): void {
  for (const finding of findings) {
    const write = finding.severity === "error" ? ctx.runtime.error : ctx.runtime.log;
    const where = finding.path !== undefined ? ` ${finding.path}` : "";
    const line = finding.line !== undefined ? `:${finding.line}` : "";
    write(`[${finding.severity}] ${finding.checkId}${where}${line} - ${finding.message}`);
    if (finding.fixHint !== undefined) {
      ctx.runtime.log(`  fix: ${finding.fixHint}`);
    }
  }
}

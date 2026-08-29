import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { ClawAddPlan, ClawDiagnostic } from "../claws/types.js";
import type { ClawUpdatePlan } from "../claws/update-plan.js";
import { redactSensitiveArgv } from "../config/redact-argv.js";
import { redactSensitiveText } from "../logging/redact.js";
import type { RuntimeEnv } from "../runtime.js";

export function formatClawDiagnostics(diagnostics: readonly ClawDiagnostic[]): string {
  return diagnostics
    .map(
      (diagnostic) =>
        `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
    )
    .join("\n");
}

export function logClawExperimentalWarning(runtime: RuntimeEnv): void {
  runtime.log("Experimental: Claws contracts may change while RFC 0016 is under review.");
}

export function logClawAddPlanSummary(plan: ClawAddPlan, runtime: RuntimeEnv): void {
  runtime.log(`Agent: ${plan.agent.finalId}`);
  runtime.log(`Workspace: ${plan.agent.workspace}`);
  runtime.log(`Actions: ${plan.summary.totalActions}`);
  runtime.log(`Packages: ${plan.summary.packageActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    const requirementState =
      typeof action.details?.requirementState === "string"
        ? action.details.requirementState
        : "unresolved";
    runtime.log(
      `  Requirement ${action.target}: ${requirementState}${action.action === "install" ? " (installation requires this exact plan consent)" : ""}`,
    );
  }
  runtime.log(`MCP servers: ${plan.summary.mcpServerActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    const server = asOptionalRecord(action.details);
    const target =
      typeof server?.url === "string"
        ? redactSensitiveUrlLikeString(server.url)
        : typeof server?.command === "string"
          ? redactSensitiveArgv([
              server.command,
              ...(Array.isArray(server.args)
                ? server.args.filter((arg): arg is string => typeof arg === "string")
                : []),
            ]).join(" ")
          : "invalid declaration";
    runtime.log(`  MCP ${action.id}: ${target}`);
  }
  runtime.log(`Cron jobs: ${plan.summary.cronJobActions}`);
  if (plan.capabilityChanges.length > 0) {
    runtime.log(`Capability escalations (${plan.capabilityChanges.length}):`);
    for (const change of plan.capabilityChanges) {
      runtime.log(
        redactSensitiveText(`  ! ${change.kind}:${change.id} ${JSON.stringify(change.effect)}`),
      );
    }
    runtime.log("The plan integrity binds every capability line above.");
  }
  if (plan.summary.blockedActions > 0) {
    runtime.log(`Blocked actions: ${plan.summary.blockedActions}`);
  }
}

export function logClawUpdatePlanSummary(plan: ClawUpdatePlan, runtime: RuntimeEnv): void {
  runtime.log(`Agent: ${plan.agentId}`);
  runtime.log(`Update actions: ${plan.summary.totalActions}`);
  runtime.log(
    `Add: ${plan.summary.added}; change: ${plan.summary.changed}; remove: ${plan.summary.removed}; release: ${plan.summary.released}; unchanged: ${plan.summary.unchanged}; manual: ${plan.summary.manual}`,
  );
  runtime.log(
    `Capability changes: ${plan.summary.capabilityChanges}; escalations requiring explicit review: ${plan.summary.capabilityEscalations}`,
  );
  runtime.log(`Plan integrity: ${plan.planIntegrity}`);
  if (plan.summary.capabilityEscalations > 0) {
    runtime.log(
      "Capability consent: the exact plan-integrity token binds every ! change disclosed below.",
    );
  }
  for (const change of plan.capabilityChanges) {
    const current = change.current?.summary ?? "unset";
    const desired = change.desired?.summary ?? "unset";
    runtime.log(
      `  ${change.requiresDistinctConsent ? "!" : "-"} ${change.path}: ${current} -> ${desired} (${change.action})`,
    );
    runtime.log(redactSensitiveText(`      effect: ${JSON.stringify(change.effect)}`));
  }
  if (plan.readiness.requirements.length > 0) {
    runtime.log(`Setup requirements (${plan.readiness.requirements.length}):`);
    for (const requirement of plan.readiness.requirements) {
      runtime.log(redactSensitiveText(`  - ${JSON.stringify(requirement)}`));
    }
  }
  if (plan.blockers.length > 0) {
    runtime.error(formatClawDiagnostics(plan.blockers));
  }
}

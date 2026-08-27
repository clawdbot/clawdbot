import type { ClawDiagnostic } from "../claws/types.js";
import type { ClawUpdatePlan } from "../claws/update-plan.js";
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

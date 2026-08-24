// Pure rendering for Claw plan previews: the log helpers only pipe these
// lines to a RuntimeEnv, so the human-readable plan text is snapshot-testable
// without touching runtime output plumbing.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import type { ClawAddPlan } from "../claws/types.js";
import type { ClawUpdatePlan } from "../claws/update-plan.js";
import { redactSensitiveArgv } from "../config/redact-argv.js";
import { redactSensitiveText } from "../logging/redact.js";

export type ClawPlanRender = {
  lines: string[];
  errors: string[];
};

export function renderClawAddPlanSummary(plan: ClawAddPlan): ClawPlanRender {
  const lines: string[] = [
    `Agent: ${plan.agent.finalId}`,
    `Workspace: ${plan.agent.workspace}`,
    `Actions: ${plan.summary.totalActions}`,
    `Packages: ${plan.summary.packageActions}`,
  ];
  for (const action of plan.actions.filter((candidate) => candidate.kind === "package")) {
    const requirementState =
      typeof action.details?.requirementState === "string"
        ? action.details.requirementState
        : "unresolved";
    lines.push(
      `  Requirement ${action.target}: ${requirementState}${action.action === "install" ? " (installation requires this exact plan consent)" : ""}`,
    );
  }
  lines.push(`MCP servers: ${plan.summary.mcpServerActions}`);
  for (const action of plan.actions.filter((candidate) => candidate.kind === "mcpServer")) {
    // SAFETY: mcpServer actions carry their declaration in details; the branch only reads strings.
    const server = action.details as Record<string, unknown> | undefined;
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
    lines.push(`  MCP ${action.id}: ${target}`);
  }
  lines.push(`Cron jobs: ${plan.summary.cronJobActions}`);
  if (plan.capabilityChanges.length > 0) {
    lines.push(`Capability escalations (${plan.capabilityChanges.length}):`);
    for (const change of plan.capabilityChanges) {
      lines.push(
        redactSensitiveText(`  ! ${change.kind}:${change.id} ${JSON.stringify(change.effect)}`),
      );
    }
    lines.push("The plan integrity binds every capability line above.");
  }
  if (plan.summary.blockedActions > 0) {
    lines.push(`Blocked actions: ${plan.summary.blockedActions}`);
  }
  return { lines, errors: [] };
}

export function renderClawUpdatePlanSummary(plan: ClawUpdatePlan): ClawPlanRender {
  const lines: string[] = [
    `Agent: ${plan.agentId}`,
    `Update actions: ${plan.summary.totalActions}`,
    `Add: ${plan.summary.added}; change: ${plan.summary.changed}; remove: ${plan.summary.removed}; release: ${plan.summary.released}; unchanged: ${plan.summary.unchanged}; manual: ${plan.summary.manual}`,
    `Capability changes: ${plan.summary.capabilityChanges}; escalations requiring explicit review: ${plan.summary.capabilityEscalations}`,
    `Plan integrity: ${plan.planIntegrity}`,
  ];
  if (plan.summary.capabilityEscalations > 0) {
    lines.push(
      "Capability consent: the exact plan-integrity token binds every ! change disclosed below.",
    );
  }
  for (const change of plan.capabilityChanges) {
    const current = change.current?.summary ?? "unset";
    const desired = change.desired?.summary ?? "unset";
    lines.push(
      `  ${change.requiresDistinctConsent ? "!" : "-"} ${change.path}: ${current} -> ${desired} (${change.action})`,
    );
    lines.push(redactSensitiveText(`      effect: ${JSON.stringify(change.effect)}`));
  }
  if (plan.readiness.requirements.length > 0) {
    lines.push(`Setup requirements (${plan.readiness.requirements.length}):`);
    for (const requirement of plan.readiness.requirements) {
      lines.push(redactSensitiveText(`  - ${JSON.stringify(requirement)}`));
    }
  }
  const errors: string[] = [];
  if (plan.blockers.length > 0) {
    errors.push(
      plan.blockers
        .map(
          (diagnostic) =>
            `${diagnostic.level.toUpperCase()} ${diagnostic.code} ${diagnostic.path}: ${diagnostic.message}`,
        )
        .join("\n"),
    );
  }
  return { lines, errors };
}

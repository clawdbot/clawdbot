import { CLAW_OUTPUT_STABILITY, type ClawDiagnostic, type ClawSourceIdentity } from "./types.js";
import { CLAW_UPDATE_PLAN_SCHEMA_VERSION, type ClawUpdatePlan } from "./update-plan-types.js";

export function makeEmptyClawUpdatePlan(params: {
  agentId: string;
  source?: ClawSourceIdentity;
  currentClaw?: ClawUpdatePlan["currentClaw"];
  found?: boolean;
  blockers: ClawDiagnostic[];
  diagnostics?: ClawDiagnostic[];
  digest: (value: unknown) => string;
}): ClawUpdatePlan {
  const plan: Omit<ClawUpdatePlan, "planIntegrity"> = {
    schemaVersion: CLAW_UPDATE_PLAN_SCHEMA_VERSION,
    stability: CLAW_OUTPUT_STABILITY,
    dryRun: true,
    mutationAllowed: false,
    found: params.found ?? false,
    agentId: params.agentId,
    ...(params.currentClaw ? { currentClaw: params.currentClaw } : {}),
    ...(params.source
      ? {
          targetClaw: {
            name: params.source.name,
            version: params.source.version,
            integrity: params.source.integrity,
          },
        }
      : {}),
    summary: {
      totalActions: 0,
      added: 0,
      changed: 0,
      removed: 0,
      released: 0,
      unchanged: 0,
      manual: 0,
      blocked: 0,
      capabilityChanges: 0,
      capabilityEscalations: 0,
    },
    actions: [],
    capabilityChanges: [],
    blockers: params.blockers,
    diagnostics: params.diagnostics ?? [],
  };
  return { ...plan, planIntegrity: params.digest(plan) };
}

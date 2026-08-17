import { createHash } from "node:crypto";
import { stableStringify } from "@openclaw/normalization-core";
import type { ClawAddPlan } from "./types.js";

type ClawAddPlanIntegrityInput = Pick<
  ClawAddPlan,
  | "manifestSchemaVersion"
  | "claw"
  | "agent"
  | "actions"
  | "capabilityChanges"
  | "blockers"
  | "extensions"
>;

export function digestClawAddPlanIntegrity(plan: ClawAddPlanIntegrityInput): string {
  return `sha256:${createHash("sha256")
    .update(
      stableStringify({
        manifestSchemaVersion: plan.manifestSchemaVersion,
        clawIntegrity: plan.claw.integrity,
        finalId: plan.agent.finalId,
        workspace: plan.agent.workspace,
        actions: plan.actions,
        capabilityChanges: plan.capabilityChanges,
        blockers: plan.blockers,
        extensions: plan.extensions,
      }),
    )
    .digest("hex")}`;
}

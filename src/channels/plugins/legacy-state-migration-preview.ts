import type { ChannelLegacyStateMigrationPlan } from "./legacy-state-migration.types.js";

export function buildLegacyMigrationPreview(plan: ChannelLegacyStateMigrationPlan): string {
  if (plan.kind === "plugin-state-import") {
    return plan.preview ?? `- ${plan.label}: ${plan.sourcePath}`;
  }
  return `- ${plan.label}: ${plan.sourcePath} → ${plan.targetPath}`;
}

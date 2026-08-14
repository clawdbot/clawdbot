import { buildLegacyMigrationPreview } from "../channels/plugins/legacy-state-migration-preview.js";
import type { ChannelLegacyStateMigrationPlan } from "../channels/plugins/legacy-state-migration.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDoctorStateMigration } from "../plugins/doctor-contract-module.js";

type PluginDoctorPlanResolver = (params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  stateDir: string;
  oauthDir: string;
}) =>
  | ChannelLegacyStateMigrationPlan[]
  | Promise<ChannelLegacyStateMigrationPlan[] | null | undefined>
  | null
  | undefined;

/** Adapts legacy channel migration plans to the canonical plugin doctor contract. */
export function definePluginDoctorMigrationFromPlans(params: {
  id: string;
  label: string;
  doctorOnly?: boolean;
  resolvePlans: PluginDoctorPlanResolver;
}): PluginDoctorStateMigration {
  const resolvePlans = async (input: {
    config: OpenClawConfig;
    env: NodeJS.ProcessEnv;
    stateDir: string;
    oauthDir: string;
  }): Promise<ChannelLegacyStateMigrationPlan[]> => {
    const plans =
      (await params.resolvePlans({
        cfg: input.config,
        env: input.env,
        stateDir: input.stateDir,
        oauthDir: input.oauthDir,
      })) ?? [];
    const resolvedPlans: ChannelLegacyStateMigrationPlan[] = [];
    for (const plan of plans) {
      resolvedPlans.push(
        plan.kind === "plugin-state-import" && !plan.stateDir
          ? { ...plan, stateDir: input.stateDir }
          : plan,
      );
    }
    return resolvedPlans;
  };

  return {
    id: params.id,
    label: params.label,
    ...(params.doctorOnly === true ? { doctorOnly: true } : {}),
    async detectLegacyState(input) {
      const plans = await resolvePlans(input);
      return plans.length > 0
        ? { preview: plans.map((plan) => buildLegacyMigrationPreview(plan)) }
        : null;
    },
    async migrateLegacyState(input) {
      const plans = await resolvePlans(input);
      const { runLegacyMigrationPlans } = await import("../infra/state-migrations.plugin-state.js");
      return await runLegacyMigrationPlans(plans);
    },
  };
}

import { readPackageVersion } from "../../infra/package-json.js";
import { planLegacyStateMigrationsReadOnly } from "../../infra/state-migrations.doctor.js";
import { refuseLegacyStateMigrationPlan } from "../../infra/state-migrations.plan.js";
import type { LegacyStateMigrationPlan } from "../../infra/state-migrations.types.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUpdateRoot } from "./shared.js";

type UpdateMigrationPlanCommandOptions = {
  snapshotConfig: string;
  snapshotHome: string;
  snapshotState: string;
};

function requiredValue(value: string, flag: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${flag} must not be blank`);
  }
  return normalized;
}

async function createUpdateMigrationPlan(params: {
  candidate: LegacyStateMigrationPlan["candidate"];
  snapshot: Pick<LegacyStateMigrationPlan["snapshot"], "homeDir" | "configPath" | "stateDir">;
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyStateMigrationPlan> {
  const plan = await planLegacyStateMigrationsReadOnly({
    mode: "doctor",
    candidate: params.candidate,
    snapshot: params.snapshot,
    env: params.env,
  });
  const observedVersion = await readPackageVersion(params.candidate.root);
  if (observedVersion !== params.candidate.version) {
    return refuseLegacyStateMigrationPlan(plan, {
      code: "candidate-identity-changed",
      message: `Candidate version changed while migration planning was in progress: expected ${params.candidate.version}, observed ${observedVersion ?? "unknown"}.`,
    });
  }
  return plan;
}

export async function updateMigrationPlanCommand(
  opts: UpdateMigrationPlanCommandOptions,
): Promise<void> {
  // Root and version are observations only. The staged-candidate owner must
  // supply an immutable artifact digest through the planner API.
  const root = await resolveUpdateRoot();
  const version = await readPackageVersion(root);
  const plan = await createUpdateMigrationPlan({
    candidate: {
      root,
      version: version ?? "unknown",
      artifact: {
        outcome: "deferred",
        refusal: {
          code: "candidate-artifact-digest-required",
          message:
            "Candidate artifact content identity must be supplied by the staged-candidate owner.",
        },
      },
    },
    snapshot: {
      homeDir: requiredValue(opts.snapshotHome, "--snapshot-home"),
      configPath: requiredValue(opts.snapshotConfig, "--snapshot-config"),
      stateDir: requiredValue(opts.snapshotState, "--snapshot-state"),
    },
  });
  defaultRuntime.writeJson(plan);
  if (plan.outcome === "refused") {
    defaultRuntime.exit(1);
  }
}

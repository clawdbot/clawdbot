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

function requireSnapshotPath(value: string, flag: string): string {
  if (!value.trim()) {
    throw new Error(`${flag} must not be blank`);
  }
  return value;
}

async function createUpdateMigrationPlan(params: {
  candidate: Pick<LegacyStateMigrationPlan["candidate"], "root" | "version">;
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
  // Root and version are observations only. This diagnostic command cannot bind
  // candidate bytes, so the planner returns a closed artifact-identity refusal.
  const root = await resolveUpdateRoot();
  const version = await readPackageVersion(root);
  const plan = await createUpdateMigrationPlan({
    candidate: {
      root,
      version: version ?? "unknown",
    },
    snapshot: {
      homeDir: requireSnapshotPath(opts.snapshotHome, "--snapshot-home"),
      configPath: requireSnapshotPath(opts.snapshotConfig, "--snapshot-config"),
      stateDir: requireSnapshotPath(opts.snapshotState, "--snapshot-state"),
    },
  });
  defaultRuntime.writeJson(plan);
  if (plan.outcome === "refused") {
    defaultRuntime.exit(1);
  }
}

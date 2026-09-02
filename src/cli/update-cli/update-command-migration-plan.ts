import { createConfigIO } from "../../config/io.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { planLegacyStateMigrationsReadOnly } from "../../infra/state-migrations.doctor.js";
import { createLegacyStateMigrationPlanEnv } from "../../infra/state-migrations.plan.js";
import type { LegacyStateMigrationPlan } from "../../infra/state-migrations.types.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveUpdateRoot } from "./shared.js";

type UpdateMigrationPlanCommandOptions = {
  candidateDigest: string;
  configDigest: string;
  snapshotConfig: string;
  snapshotHome: string;
  snapshotState: string;
  stateDigest: string;
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
  snapshot: LegacyStateMigrationPlan["snapshot"];
  env?: NodeJS.ProcessEnv;
}): Promise<LegacyStateMigrationPlan> {
  const env = createLegacyStateMigrationPlanEnv({ env: params.env, snapshot: params.snapshot });
  const warnings: string[] = [];
  const logger = {
    error: (...values: unknown[]) => warnings.push(values.map(String).join(" ")),
    warn: (...values: unknown[]) => warnings.push(values.map(String).join(" ")),
  };
  let cfg: OpenClawConfig = {};
  try {
    const snapshot = await createConfigIO({
      configPath: params.snapshot.configPath,
      env,
      homedir: () => params.snapshot.homeDir,
      logger,
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    }).readConfigFileSnapshot();
    cfg = snapshot.sourceConfig;
    if (!snapshot.exists) {
      warnings.push(`Snapshot config does not exist: ${params.snapshot.configPath}`);
    }
    warnings.push(
      ...formatConfigIssueLines(
        [...snapshot.issues, ...snapshot.legacyIssues, ...snapshot.warnings],
        "",
        { normalizeRoot: true },
      ),
    );
  } catch (error) {
    warnings.push(`Could not inspect snapshot config: ${formatErrorMessage(error)}`);
  }
  const observedVersion = await readPackageVersion(params.candidate.root);
  if (observedVersion !== params.candidate.version) {
    warnings.push(
      `Candidate version mismatch: expected ${params.candidate.version}, observed ${observedVersion ?? "unknown"}`,
    );
  }
  return await planLegacyStateMigrationsReadOnly({
    cfg,
    mode: "doctor",
    candidate: params.candidate,
    snapshot: params.snapshot,
    env,
    initialWarnings: warnings,
  });
}

export async function updateMigrationPlanCommand(
  opts: UpdateMigrationPlanCommandOptions,
): Promise<void> {
  const root = await resolveUpdateRoot();
  const version = await readPackageVersion(root);
  const plan = await createUpdateMigrationPlan({
    candidate: {
      root,
      version: version ?? "unknown",
      digest: requiredValue(opts.candidateDigest, "--candidate-digest"),
    },
    snapshot: {
      homeDir: requiredValue(opts.snapshotHome, "--snapshot-home"),
      configPath: requiredValue(opts.snapshotConfig, "--snapshot-config"),
      configDigest: requiredValue(opts.configDigest, "--config-digest"),
      stateDir: requiredValue(opts.snapshotState, "--snapshot-state"),
      stateDigest: requiredValue(opts.stateDigest, "--state-digest"),
    },
  });
  defaultRuntime.writeJson(plan);
  if (plan.outcome === "refused") {
    defaultRuntime.exit(1);
  }
}

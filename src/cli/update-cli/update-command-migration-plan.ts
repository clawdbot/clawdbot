import { createConfigIO } from "../../config/io.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { readPackageVersion } from "../../infra/package-json.js";
import { planLegacyStateMigrationsReadOnly } from "../../infra/state-migrations.doctor.js";
import {
  captureLegacyStateSnapshotIdentity,
  createLegacyStateMigrationPlan,
  createLegacyStateMigrationPlanEnv,
  refuseLegacyStateMigrationPlan,
} from "../../infra/state-migrations.plan.js";
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
  const identityBefore = await captureLegacyStateSnapshotIdentity(params.snapshot);
  const snapshot = {
    ...params.snapshot,
    ...(identityBefore.configDigest ? { configDigest: identityBefore.configDigest } : {}),
    ...(identityBefore.stateDigest ? { stateDigest: identityBefore.stateDigest } : {}),
  };
  if (identityBefore.warnings.length > 0) {
    return createLegacyStateMigrationPlan({
      mode: "doctor",
      candidate: params.candidate,
      snapshot,
      steps: [],
      warnings: identityBefore.warnings,
      refusal: {
        code: "snapshot-identity-unavailable",
        message: identityBefore.warnings.join("\n"),
      },
    });
  }
  const env = createLegacyStateMigrationPlanEnv({ env: params.env, snapshot });
  const warnings = [...identityBefore.warnings];
  const logger = {
    error: (...values: unknown[]) => warnings.push(values.map(String).join(" ")),
    warn: (...values: unknown[]) => warnings.push(values.map(String).join(" ")),
  };
  let cfg: OpenClawConfig = {};
  try {
    const configSnapshot = await createConfigIO({
      configPath: snapshot.configPath,
      env,
      homedir: () => snapshot.homeDir,
      logger,
      observe: false,
      pluginValidation: "core-only",
      shellEnvFallback: "defer",
    }).readConfigFileSnapshot();
    cfg = configSnapshot.sourceConfig;
    if (!configSnapshot.exists) {
      warnings.push(`Snapshot config does not exist: ${snapshot.configPath}`);
    }
    warnings.push(
      ...formatConfigIssueLines(
        [...configSnapshot.issues, ...configSnapshot.legacyIssues, ...configSnapshot.warnings],
        "",
        { normalizeRoot: true },
      ),
    );
  } catch (error) {
    warnings.push(`Could not inspect snapshot config: ${formatErrorMessage(error)}`);
  }
  // Identity capture brackets every planning read so the result cannot claim a
  // different copied snapshot than the one its steps describe.
  const plan = await planLegacyStateMigrationsReadOnly({
    cfg,
    mode: "doctor",
    candidate: params.candidate,
    snapshot,
    env,
    initialWarnings: warnings,
  });
  const [identityAfter, observedVersion] = await Promise.all([
    captureLegacyStateSnapshotIdentity(params.snapshot),
    readPackageVersion(params.candidate.root),
  ]);
  if (identityAfter.warnings.length > 0) {
    return refuseLegacyStateMigrationPlan(plan, {
      code: "snapshot-identity-unavailable",
      message: identityAfter.warnings.join("\n"),
    });
  }
  if (
    identityBefore.configDigest !== identityAfter.configDigest ||
    identityBefore.stateDigest !== identityAfter.stateDigest
  ) {
    return refuseLegacyStateMigrationPlan(plan, {
      code: "snapshot-identity-changed",
      message: "Copied config or state changed while migration planning was in progress.",
    });
  }
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
  // The staged-candidate owner supplies an immutable root. This command records
  // the root and version observed from the candidate process itself.
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

import fs from "node:fs/promises";
import { resolveStateDir } from "../../config/paths.js";
import type { MigrationApplyResult, MigrationProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { backupCreateCommand } from "../backup.js";
import { buildMigrationContext, buildMigrationReportDir } from "./context.js";
import { assertApplySucceeded, assertConflictFreePlan, writeApplyResult } from "./output.js";
import { applyMigrationSkillSelection } from "./selection.js";
import type { MigrateApplyOptions } from "./types.js";

function shouldTreatMissingBackupAsEmptyState(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("No local OpenClaw state was found to back up") ||
    message.includes("No OpenClaw config file was found to back up")
  );
}

export async function createPreMigrationBackup(opts: {
  output?: string;
}): Promise<string | undefined> {
  try {
    const result = await backupCreateCommand(
      {
        log() {},
        error() {},
        exit(code) {
          throw new Error(`backup exited with ${code}`);
        },
      },
      {
        output: opts.output,
        verify: true,
      },
    );
    return result.archivePath;
  } catch (err) {
    if (shouldTreatMissingBackupAsEmptyState(err)) {
      return undefined;
    }
    throw err;
  }
}

export async function runMigrationApply(params: {
  runtime: RuntimeEnv;
  opts: MigrateApplyOptions;
  providerId: string;
  provider: MigrationProviderPlugin;
}): Promise<MigrationApplyResult> {
  const preflightPlan =
    params.opts.preflightPlan ??
    (await params.provider.plan(
      buildMigrationContext({
        source: params.opts.source,
        includeSecrets: params.opts.includeSecrets,
        overwrite: params.opts.overwrite,
        runtime: params.runtime,
        json: params.opts.json,
      }),
    ));
  const selectedPlan = applyMigrationSkillSelection(preflightPlan, params.opts.skills);
  assertConflictFreePlan(selectedPlan, params.providerId);
  const stateDir = resolveStateDir();
  const reportDir = buildMigrationReportDir(params.providerId, stateDir);
  const backupPath = params.opts.noBackup
    ? undefined
    : await createPreMigrationBackup({ output: params.opts.backupOutput });
  await fs.mkdir(reportDir, { recursive: true });
  const ctx = buildMigrationContext({
    source: params.opts.source,
    includeSecrets: params.opts.includeSecrets,
    overwrite: params.opts.overwrite,
    runtime: params.runtime,
    backupPath,
    reportDir,
    json: params.opts.json,
  });
  const result = await params.provider.apply(ctx, selectedPlan);
  const withBackup = {
    ...result,
    backupPath: result.backupPath ?? backupPath,
    reportDir: result.reportDir ?? reportDir,
  };
  writeApplyResult(params.runtime, params.opts, withBackup);
  assertApplySucceeded(withBackup);
  return withBackup;
}

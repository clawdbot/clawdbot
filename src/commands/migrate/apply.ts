import fs from "node:fs/promises";
import { withProgress } from "../../cli/progress.js";
import type { ProgressReporter } from "../../cli/progress.js";
import { resolveStateDir } from "../../config/paths.js";
import type { MigrationApplyResult, MigrationProviderPlugin } from "../../plugins/types.js";
import type { RuntimeEnv } from "../../runtime.js";
import { backupCreateCommand } from "../backup.js";
import { buildMigrationContext, buildMigrationReportDir } from "./context.js";
import { assertApplySucceeded, assertConflictFreePlan, writeApplyResult } from "./output.js";
import { buildMigrationProviderOptions } from "./providers.js";
import { applyMigrationPluginSelection, applyMigrationSkillSelection } from "./selection.js";
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
  const applyMigration = async (progress?: ProgressReporter) => {
    const total = (params.opts.preflightPlan ? 0 : 1) + (params.opts.noBackup ? 0 : 1) + 1;
    let completed = 0;
    const tick = () => {
      completed += 1;
      progress?.setPercent((completed / total) * 100);
    };
    if (!params.opts.preflightPlan) {
      progress?.setLabel("Preparing migration plan…");
    }
    const preflightPlan =
      params.opts.preflightPlan ??
      (await params.provider.plan(
        buildMigrationContext({
          source: params.opts.source,
          includeSecrets: params.opts.includeSecrets,
          overwrite: params.opts.overwrite,
          configOverride: params.opts.configOverride,
          providerOptions: buildMigrationProviderOptions(params.opts),
          runtime: params.runtime,
          json: params.opts.json,
        }),
      ));
    if (!params.opts.preflightPlan) {
      tick();
    }
    const selectedPlan = applyMigrationPluginSelection(
      applyMigrationSkillSelection(preflightPlan, params.opts.skills),
      params.opts.plugins,
    );
    assertConflictFreePlan(selectedPlan, params.providerId);
    const stateDir = resolveStateDir();
    const reportDir = buildMigrationReportDir(params.providerId, stateDir);
    if (!params.opts.noBackup) {
      progress?.setLabel("Preparing migration backup…");
    }
    const backupPath = params.opts.noBackup
      ? undefined
      : await createPreMigrationBackup({ output: params.opts.backupOutput });
    if (!params.opts.noBackup) {
      tick();
    }
    await fs.mkdir(reportDir, { recursive: true });
    const ctx = buildMigrationContext({
      source: params.opts.source,
      includeSecrets: params.opts.includeSecrets,
      overwrite: params.opts.overwrite,
      configOverride: params.opts.configOverride,
      providerOptions: buildMigrationProviderOptions(params.opts),
      runtime: params.runtime,
      backupPath,
      reportDir,
      json: params.opts.json,
    });
    progress?.setLabel("Applying migration…");
    const result = await params.provider.apply(ctx, selectedPlan);
    tick();
    const withBackup = {
      ...result,
      backupPath: result.backupPath ?? backupPath,
      reportDir: result.reportDir ?? reportDir,
    };
    return withBackup;
  };
  const withBackup = params.opts.json
    ? await applyMigration()
    : await withProgress(
        { label: `Applying ${params.providerId} migration…` },
        async (progress) => await applyMigration(progress),
      );
  writeApplyResult(params.runtime, params.opts, withBackup);
  assertApplySucceeded(withBackup);
  return withBackup;
}

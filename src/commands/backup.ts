// CLI command wrapper for backup archive creation and optional verification.
import {
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateOptions,
  type BackupCreateResult,
} from "../infra/backup-create.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { recordBackupOutcomeBestEffort } from "./backup-shared.js";

type BackupVerifyRuntime = typeof import("./backup-verify.js");

const backupVerifyRuntimeLoader = createLazyImportLoader<BackupVerifyRuntime>(
  () => import("./backup-verify.js"),
);

function loadBackupVerifyRuntime(): Promise<BackupVerifyRuntime> {
  return backupVerifyRuntimeLoader.load();
}

/** Create a backup archive, optionally verify it, and emit text or JSON output. */
export async function backupCreateCommand(
  runtime: RuntimeEnv,
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  let archivePath = opts.output ?? process.cwd();
  try {
    const result = await createBackupArchive({
      ...opts,
      log: opts.log ?? (opts.json ? undefined : (message: string) => runtime.log(message)),
    });
    archivePath = result.archivePath;
    if (opts.verify && !opts.dryRun) {
      const { backupVerifyCommand } = await loadBackupVerifyRuntime();
      await backupVerifyCommand(
        {
          ...runtime,
          log: () => {},
        },
        { archive: result.archivePath, json: false },
      );
      result.verified = true;
    }
    if (!opts.dryRun) {
      recordBackupOutcomeBestEffort(runtime, {
        kind: "archive",
        archivePath,
        status: "ok",
      });
    }
    if (opts.json) {
      writeRuntimeJson(runtime, result);
    } else {
      runtime.log(formatBackupCreateSummary(result).join("\n"));
    }
    return result;
  } catch (error) {
    if (!opts.dryRun) {
      recordBackupOutcomeBestEffort(runtime, {
        kind: "archive",
        archivePath,
        status: "failed",
        error: formatErrorMessage(error),
      });
    }
    throw error;
  }
}

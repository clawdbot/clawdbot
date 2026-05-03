import {
  createBackupArchive,
  formatBackupCreateSummary,
  type BackupCreateOptions,
  type BackupCreateResult,
} from "../infra/backup-create.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
export type { BackupCreateOptions, BackupCreateResult } from "../infra/backup-create.js";

type BackupVerifyRuntime = typeof import("./backup-verify.js");

const backupVerifyRuntimeLoader = createLazyImportLoader<BackupVerifyRuntime>(
  () => import("./backup-verify.js"),
);

function loadBackupVerifyRuntime(): Promise<BackupVerifyRuntime> {
  return backupVerifyRuntimeLoader.load();
}

export async function backupCreateCommand(
  runtime: RuntimeEnv,
  opts: BackupCreateOptions = {},
): Promise<BackupCreateResult> {
  const result = await createBackupArchive(opts);
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
  if (opts.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatBackupCreateSummary(result).join("\n"));
  }
  return result;
}

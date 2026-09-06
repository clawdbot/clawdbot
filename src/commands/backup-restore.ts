// Restores one verified whole-archive backup into a fresh staging directory.
import fs from "node:fs/promises";
import path from "node:path";
import * as tar from "tar";
import { readConfigFileSnapshot, resolveStateDir } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { shortenHomePath } from "../utils.js";
import {
  BACKUP_MAX_DECOMPRESSION_RATIO,
  canonicalizePathForContainment,
  resolveBackupAgentRoots,
  resolveRequiredBackupPath,
} from "./backup-shared.js";
import { prepareBackupArchive } from "./backup-verify.js";
import { isPathWithin } from "./cleanup-utils.js";
import { resolveStartupConfigSnapshot } from "./doctor/shared/automatic-startup-config-repair.js";

const BACKUP_RESTORE_WARNINGS = [
  "Restoring an archive is time travel: every restored state surface rolls back to the archive timestamp.",
  "Messaging-channel credentials with ratchet state, especially WhatsApp, may desynchronize after rollback and require relinking.",
  "Approvals and delivery/dedupe state also roll back; review pending approvals before resuming the Gateway.",
  "Plugin node_modules are not archived; after activation, run `openclaw plugins update <id>` or reinstall with `openclaw plugins install <spec> --force`.",
  "Generated plugin-skills links are not archived; after activation, run `openclaw skills list` or start an agent session to rebuild them.",
] as const;

type BackupRestoreOptions = {
  archive: string;
  target?: string;
  json?: boolean;
};

type BackupRestoreResult = {
  ok: true;
  archivePath: string;
  targetPath: string;
  archiveRoot: string;
  createdAt: string;
  runtimeVersion: string;
  assetCount: number;
  entryCount: number;
  symlinkCount: number;
  warnings: string[];
};

async function assertTargetOutsideLiveState(targetPath: string): Promise<void> {
  const [canonicalTarget, canonicalStateDir] = await Promise.all([
    canonicalizePathForContainment(targetPath),
    canonicalizePathForContainment(resolveStateDir()),
  ]);
  if (isPathWithin(canonicalTarget, canonicalStateDir)) {
    throw new Error(
      `Backup restore target must be outside the live OpenClaw state directory: ${targetPath}`,
    );
  }
  const configSnapshot = await readConfigFileSnapshot({ observe: false });
  const discoverySnapshot = resolveStartupConfigSnapshot(configSnapshot);
  if (!discoverySnapshot) {
    return;
  }
  const agentRoots = await resolveBackupAgentRoots(discoverySnapshot.config);
  for (const { sourcePath } of agentRoots) {
    if (isPathWithin(canonicalTarget, sourcePath)) {
      throw new Error(
        `Backup restore target must be outside the live OpenClaw agent directory: ${targetPath}`,
      );
    }
  }
}

async function prepareRestoreTarget(targetPath: string): Promise<{ created: boolean }> {
  try {
    const stat = await fs.lstat(targetPath);
    if (!stat.isDirectory()) {
      throw new Error(`Backup restore target must be a directory: ${targetPath}`);
    }
    if ((await fs.readdir(targetPath)).length > 0) {
      throw new Error(`Backup restore target directory must be empty: ${targetPath}`);
    }
    return { created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  await fs.mkdir(targetPath, { recursive: true, mode: 0o700 });
  return { created: true };
}

async function cleanupFailedRestore(targetPath: string, created: boolean): Promise<void> {
  if (created) {
    await fs.rm(targetPath, { recursive: true, force: true });
    return;
  }
  for (const entry of await fs.readdir(targetPath)) {
    await fs.rm(path.join(targetPath, entry), { recursive: true, force: true });
  }
}

async function extractBackupArchive(
  archivePath: string,
  targetPath: string,
  hardlinkTargets: ReadonlyMap<string, string>,
): Promise<void> {
  let extractionError: Error | undefined;
  await tar.x({
    file: archivePath,
    gzip: true,
    maxDecompressionRatio: BACKUP_MAX_DECOMPRESSION_RATIO,
    cwd: targetPath,
    // node-tar strict mode rejects on the first warning before queued writes drain.
    // Verification catches fatal archive errors; rethrow recoverable warnings after close.
    strict: false,
    preserveOwner: false,
    // node-tar calls this before its path checks and filesystem reservations.
    onReadEntry: (entry) => {
      const target = hardlinkTargets.get(entry.path);
      if (target !== undefined) {
        entry.linkpath = target;
      }
    },
    onwarn: (code, message, data) => {
      extractionError ??=
        data instanceof Error ? data : Object.assign(new Error(`${code}: ${message}`), data);
    },
  });
  if (extractionError) {
    throw extractionError;
  }
}

function formatRestoreResult(result: BackupRestoreResult): string {
  return [
    `Backup archive restored to staging: ${shortenHomePath(result.targetPath)}`,
    `Verified archive: ${shortenHomePath(result.archivePath)}`,
    `Archive root: ${result.archiveRoot}`,
    `Archive entries restored: ${result.entryCount}`,
    "",
    "Rollback warnings:",
    ...result.warnings.map((warning) => `- ${warning}`),
    "",
    "Activation is explicit: stop the Gateway, move the restored asset tree into place or point OPENCLAW_STATE_DIR at the restored state asset, then run `openclaw doctor`.",
  ].join("\n");
}

/** Verify first, then extract a whole backup archive into a fresh staging directory. */
export async function backupRestoreCommand(
  runtime: RuntimeEnv,
  options: BackupRestoreOptions,
): Promise<BackupRestoreResult> {
  const targetPath = resolveRequiredBackupPath(options.target, "--target");
  await assertTargetOutsideLiveState(targetPath);
  const { result: verified, hardlinkTargets } = await prepareBackupArchive(options.archive);
  const target = await prepareRestoreTarget(targetPath);

  try {
    await extractBackupArchive(verified.archivePath, targetPath, hardlinkTargets);
  } catch (extractionError) {
    try {
      await cleanupFailedRestore(targetPath, target.created);
    } catch (cleanupError) {
      // Both errors are retained; extraction remains the primary cause, not cleanup.
      // oxlint-disable-next-line preserve-caught-error -- AggregateError.errors preserves the cleanup error.
      throw new AggregateError(
        [extractionError, cleanupError],
        `Backup restore failed and the incomplete target could not be cleaned: ${targetPath}. Cleanup error: ${formatErrorMessage(cleanupError)}`,
        { cause: extractionError },
      );
    }
    throw new Error(`Backup restore failed; the incomplete target was cleaned: ${targetPath}`, {
      cause: extractionError,
    });
  }

  const result: BackupRestoreResult = {
    ...verified,
    targetPath,
    warnings: [...BACKUP_RESTORE_WARNINGS],
  };
  if (options.json) {
    writeRuntimeJson(runtime, result);
  } else {
    runtime.log(formatRestoreResult(result));
  }
  return result;
}

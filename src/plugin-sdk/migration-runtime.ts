// Runtime helpers for migration providers that need filesystem side effects.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { MigrationApplyResult, MigrationItem } from "../plugins/types.js";
import {
  MIGRATION_REASON_MISSING_SOURCE_OR_TARGET,
  MIGRATION_REASON_TARGET_EXISTS,
  markMigrationItemConflict,
  markMigrationItemError,
  redactMigrationPlan,
} from "./migration.js";

export type { MigrationApplyResult, MigrationItem } from "../plugins/types.js";

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function backupExistingMigrationTarget(
  target: string,
  reportDir: string,
): Promise<string | undefined> {
  if (!(await exists(target))) {
    return undefined;
  }
  const backupRoot = path.join(reportDir, "item-backups");
  await fs.mkdir(backupRoot, { recursive: true });
  const targetHash = crypto
    .createHash("sha256")
    .update(path.resolve(target))
    .digest("hex")
    .slice(0, 12);
  const backupDir = await fs.mkdtemp(
    path.join(backupRoot, `${Date.now()}-${targetHash}-${path.basename(target)}-`),
  );
  const backupPath = path.join(backupDir, path.basename(target));
  await fs.cp(target, backupPath, { recursive: true, force: true });
  return backupPath;
}

function isFileAlreadyExistsError(err: unknown): boolean {
  return Boolean(
    err &&
    typeof err === "object" &&
    "code" in err &&
    ((err as { code?: unknown }).code === "ERR_FS_CP_EEXIST" ||
      (err as { code?: unknown }).code === "EEXIST"),
  );
}

function readArchiveRelativePath(item: MigrationItem): string {
  const detailPath = item.details?.archiveRelativePath;
  const raw = typeof detailPath === "string" && detailPath.trim() ? detailPath : undefined;
  const fallback = item.source ? path.basename(item.source) : item.id;
  const normalized = path
    .normalize(raw ?? fallback)
    .split(path.sep)
    .filter((part) => part && part !== "." && part !== "..")
    .join(path.sep);
  return normalized || "item";
}

async function resolveUniqueArchivePath(
  archiveRoot: string,
  relativePath: string,
): Promise<string> {
  const parsed = path.parse(relativePath);
  let candidate = path.join(archiveRoot, relativePath);
  let index = 2;
  while (await exists(candidate)) {
    const filename = `${parsed.name}-${index}${parsed.ext}`;
    candidate = path.join(archiveRoot, parsed.dir, filename);
    index += 1;
  }
  return candidate;
}

export async function archiveMigrationItem(
  item: MigrationItem,
  reportDir: string,
): Promise<MigrationItem> {
  if (!item.source) {
    return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
  }
  try {
    const sourceStat = await fs.lstat(item.source);
    if (sourceStat.isSymbolicLink()) {
      return markMigrationItemError(item, "archive source is a symlink");
    }
    const archiveRoot = path.join(reportDir, "archive");
    const relativePath = readArchiveRelativePath(item);
    const archivePath = await resolveUniqueArchivePath(archiveRoot, relativePath);
    await fs.mkdir(path.dirname(archivePath), { recursive: true });
    await fs.cp(item.source, archivePath, {
      recursive: true,
      force: false,
      errorOnExist: true,
      verbatimSymlinks: true,
    });
    return {
      ...item,
      status: "migrated",
      target: archivePath,
      details: { ...item.details, archivePath, archiveRelativePath: relativePath },
    };
  } catch (err) {
    if (isFileAlreadyExistsError(err)) {
      return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
    }
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}

export async function copyMigrationFileItem(
  item: MigrationItem,
  reportDir: string,
  opts: { overwrite?: boolean } = {},
): Promise<MigrationItem> {
  if (!item.source || !item.target) {
    return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
  }
  try {
    const targetExists = await exists(item.target);
    if (targetExists && !opts.overwrite) {
      return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
    }
    const backupPath = opts.overwrite
      ? await backupExistingMigrationTarget(item.target, reportDir)
      : undefined;
    await fs.mkdir(path.dirname(item.target), { recursive: true });
    await fs.cp(item.source, item.target, {
      recursive: true,
      force: Boolean(opts.overwrite),
      errorOnExist: !opts.overwrite,
    });
    return {
      ...item,
      status: "migrated",
      details: { ...item.details, ...(backupPath ? { backupPath } : {}) },
    };
  } catch (err) {
    if (isFileAlreadyExistsError(err)) {
      return markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS);
    }
    return markMigrationItemError(item, err instanceof Error ? err.message : String(err));
  }
}

export async function writeMigrationReport(
  result: MigrationApplyResult,
  opts: { title?: string } = {},
): Promise<void> {
  if (!result.reportDir) {
    return;
  }
  await fs.mkdir(result.reportDir, { recursive: true });
  await fs.writeFile(
    path.join(result.reportDir, "report.json"),
    `${JSON.stringify(redactMigrationPlan(result), null, 2)}\n`,
    "utf8",
  );
  const lines = [
    `# ${opts.title ?? "Migration Report"}`,
    "",
    `Source: ${result.source}`,
    result.target ? `Target: ${result.target}` : undefined,
    result.backupPath ? `Backup: ${result.backupPath}` : undefined,
    "",
    `Migrated: ${result.summary.migrated}`,
    `Skipped: ${result.summary.skipped}`,
    `Conflicts: ${result.summary.conflicts}`,
    `Errors: ${result.summary.errors}`,
    "",
    ...result.items.map(
      (item) => `- ${item.status}: ${item.id}${item.reason ? ` (${item.reason})` : ""}`,
    ),
  ].filter((line): line is string => typeof line === "string");
  await fs.writeFile(path.join(result.reportDir, "summary.md"), `${lines.join("\n")}\n`, "utf8");
}

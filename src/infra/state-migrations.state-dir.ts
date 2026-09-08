import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { resolveProfileStateDir } from "../cli/profile-utils.js";
import { resolveLegacyStateDirs, resolveNewStateDir, resolveStateDir } from "../config/paths.js";
import { isWithinDir } from "./path-safety.js";
import { logStateMigrationResult } from "./state-migrations.messages.js";
import {
  migrateLegacyInstalledPluginIndex,
  preflightLegacyInstalledPluginIndexMigration,
} from "./state-migrations.plugin-state.js";
import { migrateLegacyTaskStateSidecars } from "./state-migrations.storage.js";
import type { MigrationLogger } from "./state-migrations.types.js";

let autoMigrateStateDirChecked = false;
let autoMigrateTaskStateSidecarsChecked = false;

export function resetAutoMigrateLegacyStateDirForTest() {
  autoMigrateStateDirChecked = false;
}

export function resetAutoMigrateLegacyTaskStateSidecarsForTest() {
  autoMigrateTaskStateSidecarsChecked = false;
}

type StateDirMigrationResult = {
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
};

function lstatIfPresent(filePath: string): fs.Stats | null {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export function resolveLegacyProfileWorkspaceMigrationPaths(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): { source: string; target: string } | undefined {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  const profile = env.OPENCLAW_PROFILE?.trim();
  if (!profile || normalizeLowercaseStringOrEmpty(profile) === "default") {
    return undefined;
  }
  return {
    source: path.join(resolveProfileStateDir("default", env, homedir), `workspace-${profile}`),
    target: path.join(resolveProfileStateDir(profile, env, homedir), "workspace"),
  };
}

export function resolvePendingLegacyProfileWorkspaceMigrationPaths(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): { source: string; target: string } | undefined {
  const paths = resolveLegacyProfileWorkspaceMigrationPaths(params);
  // An occupied target remains pending owner work: execution refuses it, so the
  // read-only plan must retain both endpoints instead of silently omitting it.
  return paths && lstatIfPresent(paths.source) ? paths : undefined;
}

export function migrateLegacyProfileWorkspace(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): { changes: string[]; warnings: string[] } {
  const paths = resolveLegacyProfileWorkspaceMigrationPaths(params);
  if (!paths) {
    return { changes: [], warnings: [] };
  }

  try {
    const legacyDir = paths.source;
    const targetDir = paths.target;
    const legacyStat = lstatIfPresent(legacyDir);
    if (!legacyStat) {
      return { changes: [], warnings: [] };
    }
    if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
      return {
        changes: [],
        warnings: [
          `Profile workspace migration skipped: legacy path is not a directory (${legacyDir}).`,
        ],
      };
    }
    if (lstatIfPresent(targetDir)) {
      return {
        changes: [],
        warnings: [
          `Profile workspace migration skipped: target already exists (${targetDir}). Kept legacy workspace at ${legacyDir}; merge manually.`,
        ],
      };
    }
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.renameSync(legacyDir, targetDir);
    return { changes: [`Profile workspace: ${legacyDir} → ${targetDir}`], warnings: [] };
  } catch (error) {
    return {
      changes: [],
      warnings: [`Profile workspace migration failed: ${String(error)}`],
    };
  }
}

function resolveSymlinkTarget(linkPath: string): string | null {
  try {
    const target = fs.readlinkSync(linkPath);
    return path.resolve(path.dirname(linkPath), target);
  } catch {
    return null;
  }
}

function formatStateDirMigration(legacyDir: string, targetDir: string): string {
  return `State dir: ${legacyDir} → ${targetDir} (legacy path now symlinked)`;
}

function isDirPath(filePath: string): boolean {
  try {
    return fs.statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function isEmptyDirPath(filePath: string): boolean {
  try {
    return fs.readdirSync(filePath).length === 0;
  } catch {
    return false;
  }
}

function isLegacyTreeSymlinkMirror(currentDir: string, realTargetDir: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(currentDir, { withFileTypes: true });
  } catch {
    return false;
  }
  if (entries.length === 0) {
    return false;
  }

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(entryPath);
    } catch {
      return false;
    }
    if (stat.isSymbolicLink()) {
      const resolvedTarget = resolveSymlinkTarget(entryPath);
      if (!resolvedTarget) {
        return false;
      }
      let resolvedRealTarget: string;
      try {
        resolvedRealTarget = fs.realpathSync(resolvedTarget);
      } catch {
        return false;
      }
      if (!isWithinDir(realTargetDir, resolvedRealTarget)) {
        return false;
      }
      continue;
    }
    if (stat.isDirectory()) {
      if (!isLegacyTreeSymlinkMirror(entryPath, realTargetDir)) {
        return false;
      }
      continue;
    }
    return false;
  }

  return true;
}

function isLegacyDirSymlinkMirror(legacyDir: string, targetDir: string): boolean {
  let realTargetDir: string;
  try {
    realTargetDir = fs.realpathSync(targetDir);
  } catch {
    return false;
  }
  return isLegacyTreeSymlinkMirror(legacyDir, realTargetDir);
}

export function resolvePendingLegacyStateDirMigrationPaths(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
}): { source: string; target: string } | undefined {
  const env = params.env ?? process.env;
  const homedir = params.homedir ?? os.homedir;
  if (env.OPENCLAW_STATE_DIR?.trim()) {
    return undefined;
  }
  const target = resolveNewStateDir(homedir);
  const source = resolveLegacyStateDirs(homedir).find((dir) => fs.existsSync(dir));
  if (!source) {
    return undefined;
  }
  const sourceTarget = resolveSymlinkTarget(source);
  if (
    (sourceTarget && path.resolve(sourceTarget) === path.resolve(target)) ||
    (isDirPath(target) && isLegacyDirSymlinkMirror(source, target))
  ) {
    return undefined;
  }
  return { source, target };
}

export async function autoMigrateLegacyStateDir(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
}): Promise<StateDirMigrationResult> {
  if (autoMigrateStateDirChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateStateDirChecked = true;

  const homedir = params.homedir ?? os.homedir;
  const env = params.env ?? process.env;
  const warnings: string[] = [];
  const changes: string[] = [];
  const notices: string[] = [];
  const hasCustomStateDir = Boolean(env.OPENCLAW_STATE_DIR?.trim());
  const targetDir = hasCustomStateDir ? resolveStateDir(env, homedir) : resolveNewStateDir(homedir);
  const migratePluginInstallIndex = async () => {
    const result = await migrateLegacyInstalledPluginIndex({ stateDir: targetDir });
    changes.push(...result.changes);
    warnings.push(...result.warnings);
    notices.push(...(result.notices ?? []));
  };
  if (hasCustomStateDir) {
    await migratePluginInstallIndex();
    return {
      migrated: changes.length > 0,
      skipped: changes.length === 0 && warnings.length === 0 && notices.length === 0,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  const legacyDirs = resolveLegacyStateDirs(homedir);
  let legacyDir = legacyDirs.find((dir) => {
    try {
      return fs.existsSync(dir);
    } catch {
      return false;
    }
  });

  let legacyStat: fs.Stats | null;
  try {
    legacyStat = legacyDir ? fs.lstatSync(legacyDir) : null;
  } catch {
    legacyStat = null;
  }
  if (!legacyStat) {
    await migratePluginInstallIndex();
    return {
      migrated: changes.length > 0,
      skipped: false,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }
  if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
    warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
    return { migrated: false, skipped: false, changes, warnings };
  }

  let symlinkDepth = 0;
  while (legacyStat.isSymbolicLink()) {
    const legacyTarget = legacyDir ? resolveSymlinkTarget(legacyDir) : null;
    if (!legacyTarget) {
      warnings.push(
        `Legacy state dir is a symlink (${legacyDir ?? "unknown"}); could not resolve target.`,
      );
      return { migrated: false, skipped: false, changes, warnings };
    }
    if (path.resolve(legacyTarget) === path.resolve(targetDir)) {
      await migratePluginInstallIndex();
      return {
        migrated: changes.length > 0,
        skipped: false,
        changes,
        warnings,
        ...(notices.length > 0 ? { notices } : {}),
      };
    }
    if (legacyDirs.some((dir) => path.resolve(dir) === path.resolve(legacyTarget))) {
      legacyDir = legacyTarget;
      try {
        legacyStat = fs.lstatSync(legacyDir);
      } catch {
        legacyStat = null;
      }
      if (!legacyStat) {
        warnings.push(`Legacy state dir missing after symlink resolution: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      if (!legacyStat.isDirectory() && !legacyStat.isSymbolicLink()) {
        warnings.push(`Legacy state path is not a directory: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      symlinkDepth += 1;
      if (symlinkDepth > 2) {
        warnings.push(`Legacy state dir symlink chain too deep: ${legacyDir}`);
        return { migrated: false, skipped: false, changes, warnings };
      }
      continue;
    }
    warnings.push(
      `Legacy state dir is a symlink (${legacyDir ?? "unknown"} → ${legacyTarget}); skipping auto-migration.`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  if (isDirPath(targetDir)) {
    if (legacyDir && isLegacyDirSymlinkMirror(legacyDir, targetDir)) {
      await migratePluginInstallIndex();
      return {
        migrated: changes.length > 0,
        skipped: false,
        changes,
        warnings,
        ...(notices.length > 0 ? { notices } : {}),
      };
    }
    if (legacyDir && isEmptyDirPath(legacyDir)) {
      try {
        // Empty residue has no state to merge. Link it so old clients cannot recreate split state.
        fs.rmdirSync(legacyDir);
        fs.symlinkSync(targetDir, legacyDir, process.platform === "win32" ? "junction" : "dir");
        changes.push(formatStateDirMigration(legacyDir, targetDir));
      } catch (err) {
        warnings.push(`Failed to retire empty legacy state dir (${legacyDir}): ${String(err)}`);
      }
    } else {
      warnings.push(
        `State dir migration skipped: target already exists (${targetDir}). Remove or merge manually.`,
      );
    }
    await migratePluginInstallIndex();
    return {
      migrated: changes.length > 0,
      skipped: false,
      changes,
      warnings,
      ...(notices.length > 0 ? { notices } : {}),
    };
  }

  if (legacyDir) {
    const pluginInstallWarning = preflightLegacyInstalledPluginIndexMigration({
      stateDir: legacyDir,
    });
    if (pluginInstallWarning) {
      warnings.push(pluginInstallWarning);
      return { migrated: false, skipped: false, changes, warnings };
    }
  }

  try {
    if (!legacyDir) {
      throw new Error("Legacy state dir not found");
    }
    fs.renameSync(legacyDir, targetDir);
  } catch (err) {
    warnings.push(
      `Failed to move legacy state dir (${legacyDir ?? "unknown"} → ${targetDir}): ${String(err)}`,
    );
    return { migrated: false, skipped: false, changes, warnings };
  }

  try {
    if (!legacyDir) {
      throw new Error("Legacy state dir not found");
    }
    fs.symlinkSync(targetDir, legacyDir, "dir");
    changes.push(formatStateDirMigration(legacyDir, targetDir));
  } catch (err) {
    try {
      if (process.platform === "win32") {
        if (!legacyDir) {
          throw new Error("Legacy state dir not found", { cause: err });
        }
        fs.symlinkSync(targetDir, legacyDir, "junction");
        changes.push(formatStateDirMigration(legacyDir, targetDir));
      } else {
        throw err;
      }
    } catch (fallbackErr) {
      try {
        if (!legacyDir) {
          throw new Error("Legacy state dir not found", { cause: fallbackErr });
        }
        fs.renameSync(targetDir, legacyDir);
        warnings.push(
          `State dir migration rolled back (failed to link legacy path): ${String(fallbackErr)}`,
        );
        return { migrated: false, skipped: false, changes: [], warnings };
      } catch (rollbackErr) {
        warnings.push(
          `State dir moved but failed to link legacy path (${legacyDir ?? "unknown"} → ${targetDir}): ${String(fallbackErr)}`,
        );
        warnings.push(
          `Rollback failed; set OPENCLAW_STATE_DIR=${targetDir} to avoid split state: ${String(rollbackErr)}`,
        );
        changes.push(`State dir: ${legacyDir ?? "unknown"} → ${targetDir}`);
      }
    }
  }

  await migratePluginInstallIndex();
  return {
    migrated: changes.length > 0,
    skipped: false,
    changes,
    warnings,
    ...(notices.length > 0 ? { notices } : {}),
  };
}

export async function autoMigrateLegacyTaskStateSidecars(params: {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  log?: MigrationLogger;
}): Promise<{
  migrated: boolean;
  skipped: boolean;
  changes: string[];
  warnings: string[];
  notices?: string[];
}> {
  if (autoMigrateTaskStateSidecarsChecked) {
    return { migrated: false, skipped: true, changes: [], warnings: [] };
  }
  autoMigrateTaskStateSidecarsChecked = true;

  const stateDir = resolveStateDir(params.env ?? process.env, params.homedir);
  const result = await migrateLegacyTaskStateSidecars({ stateDir });
  logStateMigrationResult(result, params.log);
  return {
    migrated: result.changes.length > 0,
    skipped: false,
    changes: result.changes,
    warnings: result.warnings,
  };
}

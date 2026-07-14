import fs from "node:fs";
import path from "node:path";
import { isNamedProfile } from "../config/paths.js";
import { assertNoSymlinkParentsSync } from "./fs-safe-advanced.js";
import { expandHomePrefix, resolveRequiredHomeDir } from "./home-dir.js";
import { fileExists } from "./state-migrations.fs.js";
import type { LegacyExecApprovalsMigrationDetection } from "./state-migrations.types.js";

const EXEC_APPROVALS_FILENAME = "exec-approvals.json";
const EXEC_APPROVALS_SOCKET_FILENAME = "exec-approvals.sock";

function resolveDefaultExecApprovalsStateDir(
  env: NodeJS.ProcessEnv,
  homedir: () => string,
): string {
  return path.join(resolveRequiredHomeDir(env, homedir), ".openclaw");
}

function resolveDefaultExecApprovalsPath(env: NodeJS.ProcessEnv, homedir: () => string): string {
  return path.join(resolveDefaultExecApprovalsStateDir(env, homedir), EXEC_APPROVALS_FILENAME);
}

function resolveExecApprovalsPathForStateDir(stateDir: string): string {
  return path.join(stateDir, EXEC_APPROVALS_FILENAME);
}

function resolveExecApprovalsSocketPathForStateDir(stateDir: string): string {
  return path.join(stateDir, EXEC_APPROVALS_SOCKET_FILENAME);
}

export function detectLegacyExecApprovalsMigration(params: {
  env: NodeJS.ProcessEnv;
  homedir: () => string;
  stateDir: string;
}): LegacyExecApprovalsMigrationDetection {
  const sourcePath = resolveDefaultExecApprovalsPath(params.env, params.homedir);
  const targetPath = resolveExecApprovalsPathForStateDir(params.stateDir);
  return {
    sourcePath,
    targetPath,
    hasLegacy:
      Boolean(params.env.OPENCLAW_STATE_DIR?.trim()) &&
      !isNamedProfile(params.env) &&
      path.resolve(sourcePath) !== path.resolve(targetPath) &&
      fileExists(sourcePath) &&
      !fileExists(targetPath),
  };
}

function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isDefaultLegacyExecApprovalsSocketPath(params: {
  socketPath: string;
  sourcePath: string;
}): boolean {
  const expanded = expandHomePrefix(params.socketPath);
  return (
    path.resolve(expanded) ===
    path.join(path.dirname(params.sourcePath), EXEC_APPROVALS_SOCKET_FILENAME)
  );
}

function prepareMigratedExecApprovalsFile(params: {
  raw: string;
  sourcePath: string;
  targetPath: string;
}): { raw: string; warning?: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(params.raw) as unknown;
  } catch {
    return {
      raw: "",
      warning: `Legacy exec approvals file unreadable; left in place at ${params.sourcePath}`,
    };
  }
  if (!isPlainJsonObject(parsed) || parsed.version !== 1) {
    return {
      raw: "",
      warning: `Legacy exec approvals file has unsupported shape; left in place at ${params.sourcePath}`,
    };
  }

  const next: Record<string, unknown> = { ...parsed };
  const socket = isPlainJsonObject(next.socket) ? { ...next.socket } : {};
  const rawSocketPath = typeof socket.path === "string" ? socket.path.trim() : "";
  if (
    !rawSocketPath ||
    isDefaultLegacyExecApprovalsSocketPath({
      socketPath: rawSocketPath,
      sourcePath: params.sourcePath,
    })
  ) {
    socket.path = resolveExecApprovalsSocketPathForStateDir(path.dirname(params.targetPath));
  }
  next.socket = socket;
  return { raw: `${JSON.stringify(next, null, 2)}\n` };
}

function assertSafeExecApprovalsMigrationTarget(targetPath: string): void {
  const targetDir = path.dirname(targetPath);
  assertNoSymlinkParentsSync({
    rootDir: resolveRequiredHomeDir(),
    targetPath: targetDir,
    allowOutsideRoot: true,
    messagePrefix: "Refusing to traverse symlink in exec approvals migration path",
  });
  try {
    const targetStat = fs.lstatSync(targetPath);
    if (targetStat.isSymbolicLink()) {
      throw new Error(`Refusing to migrate exec approvals via symlink: ${targetPath}`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function writeMigratedExecApprovalsFile(targetPath: string, raw: string): boolean {
  const targetDir = path.dirname(targetPath);
  assertSafeExecApprovalsMigrationTarget(targetPath);
  fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
  assertSafeExecApprovalsMigrationTarget(targetPath);
  const dirStat = fs.lstatSync(targetDir);
  if (!dirStat.isDirectory() || dirStat.isSymbolicLink()) {
    throw new Error(`Refusing to migrate exec approvals into unsafe directory: ${targetDir}`);
  }
  try {
    fs.chmodSync(targetDir, 0o700);
  } catch {
    // best-effort on platforms without chmod
  }
  const tempPath = path.join(targetDir, `.exec-approvals.migration.${process.pid}.tmp`);
  fs.writeFileSync(tempPath, raw, { encoding: "utf8", mode: 0o600, flag: "wx" });
  try {
    try {
      fs.copyFileSync(tempPath, targetPath, fs.constants.COPYFILE_EXCL);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        return false;
      }
      try {
        fs.rmSync(targetPath, { force: true });
      } catch {
        // best-effort cleanup for an incomplete exclusive copy target
      }
      throw err;
    }
    try {
      fs.chmodSync(targetPath, 0o600);
    } catch {
      // best-effort on platforms without chmod
    }
    return true;
  } finally {
    fs.rmSync(tempPath, { force: true });
  }
}

function archiveMigratedExecApprovalsSource(sourcePath: string): string {
  let archivePath = `${sourcePath}.migrated`;
  if (fileExists(archivePath)) {
    archivePath = `${archivePath}-${Date.now()}`;
  }
  fs.renameSync(sourcePath, archivePath);
  return archivePath;
}

export function migrateLegacyExecApprovals(detected: LegacyExecApprovalsMigrationDetection): {
  changes: string[];
  warnings: string[];
} {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (!detected.hasLegacy) {
    return { changes, warnings };
  }
  if (fileExists(detected.targetPath)) {
    return { changes, warnings };
  }
  try {
    const sourceStat = fs.lstatSync(detected.sourcePath);
    if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
      warnings.push(
        `Legacy exec approvals file is not a regular file; left in place at ${detected.sourcePath}`,
      );
      return { changes, warnings };
    }
    try {
      const targetStat = fs.lstatSync(detected.targetPath);
      if (targetStat.isSymbolicLink()) {
        warnings.push(
          `Target exec approvals path is a symlink; skipped migration at ${detected.targetPath}`,
        );
        return { changes, warnings };
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
    const prepared = prepareMigratedExecApprovalsFile({
      raw: fs.readFileSync(detected.sourcePath, "utf8"),
      sourcePath: detected.sourcePath,
      targetPath: detected.targetPath,
    });
    if (prepared.warning) {
      warnings.push(prepared.warning);
      return { changes, warnings };
    }
    if (!writeMigratedExecApprovalsFile(detected.targetPath, prepared.raw)) {
      return { changes, warnings };
    }
    changes.push(`Migrated exec approvals → ${detected.targetPath}`);
    try {
      const archivePath = archiveMigratedExecApprovalsSource(detected.sourcePath);
      changes.push(`Archived legacy exec approvals → ${archivePath}`);
    } catch (err) {
      warnings.push(
        `Failed archiving legacy exec approvals at ${detected.sourcePath}: ${String(err)}`,
      );
    }
  } catch (err) {
    warnings.push(
      `Failed migrating exec approvals (${detected.sourcePath} → ${detected.targetPath}): ${String(
        err,
      )}`,
    );
  }
  return { changes, warnings };
}

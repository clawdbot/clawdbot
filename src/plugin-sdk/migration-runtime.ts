// Runtime helpers for migration providers that need filesystem side effects.

import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { writeTextAtomic } from "@openclaw/fs-safe/atomic";
import { resolveAgentConfig } from "../agents/agent-scope-config.js";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { ensureAbsoluteDirectory, pathExists, root as openFsSafeRoot } from "../infra/fs-safe.js";
import { resolveHomeRelativePath } from "../infra/home-dir.js";
import {
  assertMemoryMigrationSourceRevision,
  MAX_MEMORY_MIGRATION_FILE_BYTES,
} from "./memory-migration-source.js";
import {
  MIGRATION_REASON_MISSING_SOURCE_OR_TARGET,
  MIGRATION_REASON_TARGET_EXISTS,
  markMigrationItemConflict,
  markMigrationItemError,
  redactMigrationPlan,
} from "./migration.js";
import type {
  MigrationApplyResult,
  MigrationItem,
  MigrationProviderContext,
} from "./plugin-entry.js";

export type { MigrationApplyResult, MigrationItem } from "./plugin-entry.js";

/** Directories a migration provider writes imported agent data into. */
export type PlannedMigrationTargets = {
  workspaceDir: string;
  stateDir: string;
  agentDir: string;
};

/**
 * Resolves default agent workspace/state/agent directories. Prefers the runtime resolver,
 * then configured agentDir (using effective-home resolution), then canonical state layout.
 */
export function resolvePlannedMigrationTargets(
  ctx: MigrationProviderContext,
): PlannedMigrationTargets {
  const cfg = ctx.config;
  const agentId = ctx.targetAgentId ?? resolveDefaultAgentId(cfg);
  const workspaceDir = resolveAgentWorkspaceDir(cfg, agentId);
  const configuredAgentDir = resolveAgentConfig(cfg, agentId)?.agentDir?.trim();
  const agentDir =
    ctx.runtime?.agent?.resolveAgentDir(cfg, agentId) ??
    (configuredAgentDir ? resolveHomeRelativePath(configuredAgentDir) : undefined) ??
    path.join(ctx.stateDir, "agents", agentId, "agent");
  return {
    workspaceDir,
    stateDir: ctx.stateDir,
    agentDir,
  };
}

/** Wrap migration runtime config access with a cached mutable snapshot during apply. */
export function withCachedMigrationConfigRuntime(
  runtime: MigrationProviderContext["runtime"] | undefined,
  fallbackConfig: MigrationProviderContext["config"],
): MigrationProviderContext["runtime"] | undefined {
  if (!runtime) {
    return undefined;
  }
  const configApi = runtime.config;
  if (!configApi?.current || !configApi.mutateConfigFile) {
    return runtime;
  }
  let cachedConfig: MigrationProviderContext["config"] | undefined;
  const current = (): ReturnType<typeof configApi.current> => {
    cachedConfig ??= structuredClone(
      (configApi.current() ?? fallbackConfig) as MigrationProviderContext["config"],
    );
    return cachedConfig;
  };
  return {
    ...runtime,
    config: {
      ...runtime.config,
      current,
      mutateConfigFile: async (params) => {
        const result = await configApi.mutateConfigFile({
          ...params,
          mutate: async (draft, context) => {
            const mutationResult = await params.mutate(draft, context);
            cachedConfig = structuredClone(draft);
            return mutationResult;
          },
        });
        cachedConfig = structuredClone(result.nextConfig);
        return result;
      },
      ...(configApi.replaceConfigFile
        ? {
            replaceConfigFile: async (params) => {
              const result = await configApi.replaceConfigFile(params);
              cachedConfig = structuredClone(result.nextConfig);
              return result;
            },
          }
        : {}),
    },
  };
}

async function backupExistingMigrationTarget(
  target: string,
  reportDir: string,
): Promise<string | undefined> {
  if (!(await pathExists(target))) {
    return undefined;
  }
  const backupRoot = path.join(reportDir, "item-backups");
  await fs.mkdir(backupRoot, { recursive: true });
  const targetHash = crypto
    .createHash("sha256")
    .update(path.resolve(target))
    .digest("hex")
    .slice(0, 12);
  const backupDir = await fs.mkdtemp(path.join(backupRoot, `${Date.now()}-${targetHash}-`));
  const backupPath = path.join(backupDir, path.basename(target));
  await fs.cp(target, backupPath, { recursive: true, force: true });
  return backupPath;
}

async function backupMemoryMigrationTarget(
  target: string,
  contents: Buffer,
  reportDir: string,
): Promise<string> {
  const backupRoot = path.join(reportDir, "item-backups");
  await fs.mkdir(backupRoot, { recursive: true });
  const targetHash = crypto
    .createHash("sha256")
    .update(path.resolve(target))
    .digest("hex")
    .slice(0, 12);
  const backupDir = await fs.mkdtemp(path.join(backupRoot, `${Date.now()}-${targetHash}-`));
  const backupPath = path.join(backupDir, path.basename(target));
  await fs.writeFile(backupPath, contents, { flag: "wx", mode: 0o600 });
  return backupPath;
}

type MemoryMigrationRecoveryStatus = "complete" | "prepared" | "recovery-required" | "safe";

async function persistMemoryMigrationRecoveryRecord(
  recoveryRecordPath: string,
  params: {
    backupPath: string;
    recoveryPath: string;
    status: MemoryMigrationRecoveryStatus;
    target: string;
  },
): Promise<void> {
  await writeTextAtomic(recoveryRecordPath, JSON.stringify({ version: 1, ...params }, null, 2), {
    mode: 0o600,
    trailingNewline: true,
  });
}

async function writeMemoryMigrationRecoveryRecord(params: {
  backupPath: string;
  recoveryPath: string;
  target: string;
}): Promise<string> {
  const recoveryRecordPath = path.join(
    path.dirname(params.backupPath),
    `recovery-${crypto.randomUUID()}.json`,
  );
  await persistMemoryMigrationRecoveryRecord(recoveryRecordPath, {
    ...params,
    status: "prepared",
  });
  return recoveryRecordPath;
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function openMemoryMigrationRoot(workspaceDir: string) {
  const options = {
    hardlinks: "reject" as const,
    maxBytes: MAX_MEMORY_MIGRATION_FILE_BYTES,
    mkdir: true,
    symlinks: "reject" as const,
  };
  try {
    return await openFsSafeRoot(workspaceDir, options);
  } catch (error) {
    if (errorCode(error) !== "not-found" && errorCode(error) !== "ENOENT") {
      throw error;
    }
  }
  const ensured = await ensureAbsoluteDirectory(workspaceDir, {
    scopeLabel: "memory import workspace",
    mode: 0o700,
  });
  if (!ensured.ok) {
    throw ensured.error;
  }
  return await openFsSafeRoot(ensured.path, options);
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
  while (await pathExists(candidate)) {
    const filename = `${parsed.name}-${index}${parsed.ext}`;
    candidate = path.join(archiveRoot, parsed.dir, filename);
    index += 1;
  }
  return candidate;
}

/** Archive a migration item source into the report directory and mark the item migrated. */
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

/** Copy a migration item source to its target, optionally backing up an overwritten target. */
export async function copyMigrationFileItem(
  item: MigrationItem,
  reportDir: string,
  opts: { overwrite?: boolean } = {},
): Promise<MigrationItem> {
  if (!item.source || !item.target) {
    return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
  }
  try {
    const targetExists = await pathExists(item.target);
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

/** Copy one regular memory file through an fs-safe workspace root. */
export async function copyMemoryMigrationFileItem(
  item: MigrationItem,
  reportDir: string,
  opts: { workspaceDir: string; overwrite?: boolean },
): Promise<MigrationItem> {
  if (!item.source || !item.target) {
    return markMigrationItemError(item, MIGRATION_REASON_MISSING_SOURCE_OR_TARGET);
  }
  let backupPath: string | undefined;
  let stagedRelative: string | undefined;
  let stagingDir: string | undefined;
  let recoveryPath: string | undefined;
  let recoveryRecordPath: string | undefined;
  let journalRecoveryPath: string | undefined;
  let relativeTarget: string | undefined;
  let targetCreated = false;
  let safeRoot: Awaited<ReturnType<typeof openMemoryMigrationRoot>> | undefined;
  try {
    const workspaceDir = path.resolve(opts.workspaceDir);
    relativeTarget = path.relative(workspaceDir, path.resolve(item.target));
    safeRoot = await openMemoryMigrationRoot(workspaceDir);
    // A hardlink inside a source tree can alias sensitive bytes outside that tree.
    const sourceRoot = await openFsSafeRoot(path.dirname(item.source), {
      hardlinks: "reject",
      maxBytes: MAX_MEMORY_MIGRATION_FILE_BYTES,
      symlinks: "reject",
    });
    const { buffer: sourceBuffer } = await sourceRoot.read(path.basename(item.source), {
      hardlinks: "reject",
      maxBytes: MAX_MEMORY_MIGRATION_FILE_BYTES,
      symlinks: "reject",
    });
    assertMemoryMigrationSourceRevision(item, sourceBuffer);
    const replaceExisting = opts.overwrite === true && (await safeRoot.exists(relativeTarget));
    if (replaceExisting) {
      const existing = await safeRoot.read(relativeTarget, {
        hardlinks: "reject",
        maxBytes: MAX_MEMORY_MIGRATION_FILE_BYTES,
        symlinks: "reject",
      });
      backupPath = await backupMemoryMigrationTarget(item.target, existing.buffer, reportDir);
      stagingDir = path.join(".openclaw-memory-import-staging", crypto.randomUUID());
      stagedRelative = path.join(stagingDir, path.basename(relativeTarget));
      const plannedRecoveryPath = path.join(safeRoot.rootReal, stagedRelative);
      journalRecoveryPath = plannedRecoveryPath;
      await safeRoot.mkdir(stagingDir);
      // Persist the exact staging location before moving the destination. A
      // crash after the move can then be recovered without filesystem search.
      recoveryRecordPath = await writeMemoryMigrationRecoveryRecord({
        backupPath,
        recoveryPath: plannedRecoveryPath,
        target: item.target,
      });
      recoveryPath = plannedRecoveryPath;
      await safeRoot.move(relativeTarget, stagedRelative, { overwrite: false });
      const staged = await safeRoot.read(stagedRelative, {
        hardlinks: "reject",
        maxBytes: MAX_MEMORY_MIGRATION_FILE_BYTES,
        symlinks: "reject",
      });
      if (!staged.buffer.equals(existing.buffer)) {
        backupPath = await backupMemoryMigrationTarget(item.target, staged.buffer, reportDir);
        await persistMemoryMigrationRecoveryRecord(recoveryRecordPath, {
          backupPath,
          recoveryPath: plannedRecoveryPath,
          status: "prepared",
          target: item.target,
        });
      }
    }
    // Exclusive create keeps a destination that races the import user-owned.
    await safeRoot.create(relativeTarget, sourceBuffer, {
      mkdir: true,
      mode: 0o600,
    });
    targetCreated = true;
    if (recoveryRecordPath && backupPath && journalRecoveryPath) {
      await persistMemoryMigrationRecoveryRecord(recoveryRecordPath, {
        backupPath,
        recoveryPath: journalRecoveryPath,
        status: "complete",
        target: item.target,
      });
    }
    if (stagedRelative) {
      await safeRoot.remove(stagedRelative);
      stagedRelative = undefined;
      recoveryPath = undefined;
    }
    if (stagingDir) {
      await safeRoot.remove(stagingDir);
      await safeRoot.remove(".openclaw-memory-import-staging").catch(() => undefined);
    }
    if (recoveryRecordPath) {
      try {
        await fs.unlink(recoveryRecordPath);
        recoveryRecordPath = undefined;
      } catch {
        // Retained records are already marked complete and returned below.
      }
    }
    return {
      ...item,
      status: "migrated",
      details: {
        ...item.details,
        ...(backupPath ? { backupPath } : {}),
        ...(recoveryRecordPath ? { recoveryRecordPath } : {}),
      },
    };
  } catch (error) {
    if (safeRoot && stagedRelative && relativeTarget && !targetCreated) {
      try {
        if (!(await safeRoot.exists(stagedRelative))) {
          recoveryPath = undefined;
        } else if (!(await safeRoot.exists(relativeTarget))) {
          await safeRoot.move(stagedRelative, relativeTarget, { overwrite: false });
          stagedRelative = undefined;
          recoveryPath = undefined;
        }
      } catch {
        // Keep the journal and staged original for operator recovery.
      }
    }
    if (recoveryRecordPath && backupPath && journalRecoveryPath) {
      await persistMemoryMigrationRecoveryRecord(recoveryRecordPath, {
        backupPath,
        recoveryPath: journalRecoveryPath,
        status: targetCreated ? "complete" : recoveryPath ? "recovery-required" : "safe",
        target: item.target,
      }).catch(() => undefined);
    }
    const details = {
      ...item.details,
      ...(backupPath ? { backupPath } : {}),
      ...(recoveryPath ? { recoveryPath } : {}),
      ...(recoveryRecordPath ? { recoveryRecordPath } : {}),
    };
    if (isFileAlreadyExistsError(error) || errorCode(error) === "already-exists") {
      return {
        ...markMigrationItemConflict(item, MIGRATION_REASON_TARGET_EXISTS),
        details,
      };
    }
    return {
      ...markMigrationItemError(item, error instanceof Error ? error.message : String(error)),
      details,
    };
  }
}

/** Write redacted JSON and Markdown migration reports into the apply report directory. */
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

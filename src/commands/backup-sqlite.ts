import fs from "node:fs/promises";
import path from "node:path";
import { resolveConfiguredAgentId } from "../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../config/config.js";
import { formatErrorMessage } from "../infra/errors.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { type RuntimeEnv, writeRuntimeJson } from "../runtime.js";
import { createLocalSqliteSnapshotProvider } from "../snapshot/local-repository.js";
import type {
  SnapshotDatabaseManifest,
  SnapshotManifest,
  SnapshotRef,
  SnapshotSummary,
} from "../snapshot/snapshot-provider.js";
import { recordBackupRunOutcome } from "../state/backup-run-records.js";
import { resolveOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.paths.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { shortenHomePath } from "../utils.js";
import { resolveRequiredBackupPath } from "./backup-shared.js";

type BackupSqliteCreateOptions = {
  global?: boolean;
  agent?: string;
  repository?: string;
  json?: boolean;
};

type BackupSqliteRepositoryOptions = {
  repository?: string;
  json?: boolean;
};

type BackupSqliteJsonOptions = {
  json?: boolean;
};

type BackupSqliteVerifyOptions = BackupSqliteJsonOptions & {
  scratch?: string;
};

type BackupSqliteRestoreOptions = BackupSqliteJsonOptions & {
  target?: string;
};

type BackupSqliteCreateResult = {
  ok: true;
  snapshotPath: string;
  manifest: SnapshotManifest;
};

type BackupSqliteListResult = {
  ok: true;
  repositoryPath: string;
  snapshots: SnapshotSummary[];
};

type BackupSqliteVerifyResult = {
  ok: true;
  snapshotPath: string;
  manifest: SnapshotManifest;
};

type BackupSqliteRestoreResult = BackupSqliteVerifyResult & {
  targetPath: string;
};

type ResolvedSnapshotDatabase = {
  path: string;
  identity: { role: "global" } | { role: "agent"; agentId: string };
};

const OPENCLAW_SNAPSHOT_READ_OPTIONS = {
  allowedDatabaseRoles: ["global", "agent"],
} as const;

export async function backupSqliteCreateCommand(
  runtime: RuntimeEnv,
  options: BackupSqliteCreateOptions,
): Promise<BackupSqliteCreateResult> {
  const repositoryPath = resolveRequiredBackupPath(options.repository, "--repository");
  try {
    const database = await resolveSnapshotDatabase(options);
    const result = await createLocalSqliteSnapshotProvider({ repositoryPath }).create(database);
    const report: BackupSqliteCreateResult = {
      ok: true,
      snapshotPath: result.ref.path,
      manifest: result.manifest,
    };
    recordSqliteOutcomeBestEffort(runtime, {
      archivePath: report.snapshotPath,
      status: "ok",
    });
    writeCreateResult(runtime, options, report);
    return report;
  } catch (error) {
    recordSqliteOutcomeBestEffort(runtime, {
      archivePath: repositoryPath,
      status: "failed",
      error: formatErrorMessage(error),
    });
    throw error;
  }
}

function recordSqliteOutcomeBestEffort(
  runtime: RuntimeEnv,
  params: { archivePath: string; status: "ok" | "failed"; error?: string },
): void {
  try {
    recordBackupRunOutcome({ kind: "sqlite-snapshot", ...params });
  } catch (error) {
    runtime.error(
      `Warning: the backup outcome could not be recorded: ${formatErrorMessage(error)}`,
    );
  }
}

export async function backupSqliteListCommand(
  runtime: RuntimeEnv,
  options: BackupSqliteRepositoryOptions,
): Promise<BackupSqliteListResult> {
  const repositoryPath = resolveRequiredBackupPath(options.repository, "--repository");
  const snapshots = await createLocalSqliteSnapshotProvider({
    repositoryPath,
    ...OPENCLAW_SNAPSHOT_READ_OPTIONS,
  }).list();
  const report: BackupSqliteListResult = {
    ok: true,
    repositoryPath,
    snapshots,
  };
  writeListResult(runtime, options, report);
  return report;
}

export async function backupSqliteVerifyCommand(
  runtime: RuntimeEnv,
  snapshot: string,
  options: BackupSqliteVerifyOptions,
): Promise<BackupSqliteVerifyResult> {
  const resolved = resolveSnapshot(snapshot, options.scratch);
  const verified = await resolved.provider.verify(resolved.ref);
  const report: BackupSqliteVerifyResult = {
    ok: true,
    snapshotPath: resolved.ref.path,
    manifest: verified.manifest,
  };
  writeVerifyResult(runtime, options, report);
  return report;
}

export async function backupSqliteRestoreCommand(
  runtime: RuntimeEnv,
  snapshot: string,
  options: BackupSqliteRestoreOptions,
): Promise<BackupSqliteRestoreResult> {
  const resolved = resolveSnapshot(snapshot);
  const targetPath = resolveRequiredBackupPath(options.target, "--target");
  const restored = await resolved.provider.restoreFresh(resolved.ref, targetPath);
  const report: BackupSqliteRestoreResult = {
    ok: true,
    snapshotPath: resolved.ref.path,
    targetPath,
    manifest: restored.manifest,
  };
  writeRestoreResult(runtime, options, report);
  return report;
}

async function resolveSnapshotDatabase(
  options: BackupSqliteCreateOptions,
): Promise<ResolvedSnapshotDatabase> {
  const rawAgentId = options.agent?.trim();
  if (options.agent !== undefined && !rawAgentId) {
    throw new Error("--agent must not be blank");
  }
  if (options.global === true && rawAgentId) {
    throw new Error("Choose exactly one SQLite snapshot source: --global or --agent <id>.");
  }
  if (options.global !== true && !rawAgentId) {
    throw new Error("Choose a SQLite snapshot source: --global or --agent <id>.");
  }
  if (options.global === true) {
    return {
      path: await fs.realpath(resolveOpenClawStateSqlitePath()),
      identity: { role: "global" },
    };
  }
  const agentId = resolveConfiguredAgentId(
    getRuntimeConfig({ skipPluginValidation: true }),
    normalizeAgentId(rawAgentId),
  );
  return {
    path: await fs.realpath(resolveOpenClawAgentSqlitePath({ agentId })),
    identity: { role: "agent", agentId },
  };
}

function resolveSnapshot(
  snapshot: string,
  scratch?: string,
): {
  provider: ReturnType<typeof createLocalSqliteSnapshotProvider>;
  ref: SnapshotRef;
} {
  const snapshotPath = resolveRequiredBackupPath(snapshot, "<snapshot>");
  const repositoryPath = path.dirname(snapshotPath);
  const validationRootPath = scratch
    ? resolveRequiredBackupPath(scratch, "--scratch")
    : path.dirname(repositoryPath);
  return {
    provider: createLocalSqliteSnapshotProvider({
      repositoryPath,
      validationRootPath,
      ...OPENCLAW_SNAPSHOT_READ_OPTIONS,
    }),
    ref: { path: snapshotPath },
  };
}

function formatDatabaseIdentity(database: SnapshotDatabaseManifest): string {
  if (database.role === "global") {
    return "global";
  }
  if (database.role === "agent") {
    return `agent:${database.agentId}`;
  }
  return database.id;
}

function writeCreateResult(
  runtime: RuntimeEnv,
  options: BackupSqliteJsonOptions,
  report: BackupSqliteCreateResult,
): void {
  if (options.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(
    [
      `SQLite snapshot created: ${shortenHomePath(report.snapshotPath)}`,
      `Database: ${formatDatabaseIdentity(report.manifest.database)}`,
      `Size: ${report.manifest.artifact.sizeBytes} bytes`,
    ].join("\n"),
  );
}

function writeListResult(
  runtime: RuntimeEnv,
  options: BackupSqliteJsonOptions,
  report: BackupSqliteListResult,
): void {
  if (options.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  if (report.snapshots.length === 0) {
    runtime.log(`No SQLite snapshots in ${shortenHomePath(report.repositoryPath)}.`);
    return;
  }
  runtime.log(
    report.snapshots
      .map(
        (snapshot) =>
          `${snapshot.manifest.createdAt}  ${formatDatabaseIdentity(snapshot.manifest.database)}  ${snapshot.manifest.artifact.sizeBytes} bytes  ${shortenHomePath(snapshot.ref.path)}`,
      )
      .join("\n"),
  );
}

function writeVerifyResult(
  runtime: RuntimeEnv,
  options: BackupSqliteJsonOptions,
  report: BackupSqliteVerifyResult,
): void {
  if (options.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(
    `SQLite snapshot verified: ${shortenHomePath(report.snapshotPath)} (${formatDatabaseIdentity(report.manifest.database)})`,
  );
}

function writeRestoreResult(
  runtime: RuntimeEnv,
  options: BackupSqliteJsonOptions,
  report: BackupSqliteRestoreResult,
): void {
  if (options.json) {
    writeRuntimeJson(runtime, report);
    return;
  }
  runtime.log(
    `SQLite snapshot restored: ${shortenHomePath(report.targetPath)} (${formatDatabaseIdentity(report.manifest.database)})`,
  );
}

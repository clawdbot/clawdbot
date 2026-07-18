// Startup/Doctor migration for the retired restart-sentinel JSON file.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { root, type Root } from "@openclaw/fs-safe";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { formatErrorMessage } from "./errors.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  parseRestartSentinelEnvelope,
  readRestartSentinelRowSync,
  writeRestartSentinelRowSync,
  type RestartSentinelEnvelope,
} from "./restart-sentinel-store.js";
import type { LegacyRestartSentinelDetection } from "./state-migrations.restart-sentinel.types.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const LEGACY_RESTART_SENTINEL_FILENAME = "restart-sentinel.json";
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const MAX_LEGACY_RESTART_SENTINEL_BYTES = 4 * 1024 * 1024;
const MIGRATION_KIND = "legacy-restart-sentinel-json";
const MIGRATION_LOCK_TIMEOUT_MS = 250;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 25;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type RestartSentinelMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "gateway_restart_sentinel" | "migration_runs" | "migration_sources"
>;

type LegacySourceSnapshot = {
  buffer: Buffer;
  dev: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  size: number;
};

type MigrationDecision =
  | "canonical-preserved"
  | "invalid-canonical-repaired"
  | "legacy-imported"
  | "malformed-legacy-discarded"
  | "receipt-authoritative";

function legacyPathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Detect the exact retired file for startup preflight and explicit Doctor alike. */
export function detectLegacyRestartSentinel(params: {
  stateDir: string;
}): LegacyRestartSentinelDetection {
  const sourcePath = path.join(params.stateDir, LEGACY_RESTART_SENTINEL_FILENAME);
  return {
    sourcePath,
    hasLegacy:
      legacyPathMayExist(sourcePath) || legacyPathMayExist(`${sourcePath}${DOCTOR_CLAIM_SUFFIX}`),
  };
}

function relativeLegacyPath(stateDir: string, filePath: string): string {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(filePath));
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("legacy restart sentinel path is outside the state directory");
  }
  return relativePath;
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
): Promise<LegacySourceSnapshot> {
  const opened = await stateRoot.read(relativeLegacyPath(stateDir, sourcePath), {
    hardlinks: "reject",
    maxBytes: MAX_LEGACY_RESTART_SENTINEL_BYTES,
    symlinks: "reject",
  });
  if (!opened.stat.isFile() || opened.stat.size !== opened.buffer.byteLength) {
    throw new Error("legacy restart sentinel is not a stable regular file");
  }
  return {
    buffer: opened.buffer,
    dev: opened.stat.dev,
    ino: opened.stat.ino,
    mtimeMs: opened.stat.mtimeMs,
    sha256: createHash("sha256").update(opened.buffer).digest("hex"),
    size: opened.stat.size,
  };
}

function snapshotsMatch(left: LegacySourceSnapshot, right: LegacySourceSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function parseLegacyEnvelope(snapshot: LegacySourceSnapshot): RestartSentinelEnvelope | null {
  try {
    return parseRestartSentinelEnvelope(JSON.parse(utf8Decoder.decode(snapshot.buffer)));
  } catch {
    return null;
  }
}

function receiptSourceKey(sourcePath: string): string {
  return `restart-sentinel-json:${createHash("sha256").update(path.resolve(sourcePath)).digest("hex")}`;
}

function hasMigrationReceipt(sourcePath: string, env: NodeJS.ProcessEnv): boolean {
  const { db } = openOpenClawStateDatabase({ env });
  return Boolean(
    executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<RestartSentinelMigrationDatabase>(db)
        .selectFrom("migration_sources")
        .select("source_key")
        .where("source_key", "=", receiptSourceKey(sourcePath)),
    ),
  );
}

function decideAndRecordMigration(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
  envelope: RestartSentinelEnvelope | null;
}): { decision: MigrationDecision; sourceKey: string } {
  const sourceKey = receiptSourceKey(params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<RestartSentinelMigrationDatabase>(db);
      const receipt = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("migration_sources")
          .select("source_key")
          .where("source_key", "=", sourceKey),
      );
      const before = readRestartSentinelRowSync(db);
      let decision: MigrationDecision;
      if (receipt) {
        decision = "receipt-authoritative";
      } else if (!params.envelope) {
        decision = "malformed-legacy-discarded";
      } else if (before.kind === "valid") {
        decision = "canonical-preserved";
      } else {
        const written = writeRestartSentinelRowSync(db, params.envelope.payload);
        const verified = readRestartSentinelRowSync(db);
        if (
          verified.kind !== "valid" ||
          verified.sentinel.revision !== written.revision ||
          !isDeepStrictEqual(verified.sentinel.payload, params.envelope.payload)
        ) {
          throw new Error("SQLite verification failed for the restart sentinel migration");
        }
        decision = before.kind === "invalid" ? "invalid-canonical-repaired" : "legacy-imported";
      }

      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: "gateway_restart_sentinel",
        decision,
        sourceSha256: params.snapshot.sha256,
        sourceValid: params.envelope !== null,
        importedRecordCount:
          decision === "legacy-imported" || decision === "invalid-canonical-repaired" ? 1 : 0,
        preservedSqliteRecordCount: decision === "canonical-preserved" ? 1 : 0,
      });
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("migration_runs")
          .values({
            id: runId,
            started_at: now,
            finished_at: now,
            status: "completed",
            report_json: reportJson,
          })
          .onConflict((conflict) =>
            conflict.column("id").doUpdateSet({
              finished_at: now,
              status: "completed",
              report_json: reportJson,
            }),
          ),
      );
      executeSqliteQuerySync(
        db,
        stateDb
          .insertInto("migration_sources")
          .values({
            source_key: sourceKey,
            migration_kind: MIGRATION_KIND,
            source_path: params.sourcePath,
            target_table: "gateway_restart_sentinel",
            source_sha256: params.snapshot.sha256,
            source_size_bytes: params.snapshot.size,
            source_record_count: params.envelope ? 1 : 0,
            last_run_id: runId,
            status: "completed",
            imported_at: now,
            removed_source: 0,
            report_json: reportJson,
          })
          .onConflict((conflict) =>
            conflict.column("source_key").doUpdateSet({
              source_sha256: params.snapshot.sha256,
              source_size_bytes: params.snapshot.size,
              source_record_count: params.envelope ? 1 : 0,
              last_run_id: runId,
              status: "completed",
              imported_at: now,
              removed_source: 0,
              report_json: reportJson,
            }),
          ),
      );
      return { decision, sourceKey };
    },
    { env: params.env },
  );
}

function markSourceRemoved(sourceKey: string, env: NodeJS.ProcessEnv): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<RestartSentinelMigrationDatabase>(db)
          .updateTable("migration_sources")
          .set({ removed_source: 1 })
          .where("source_key", "=", sourceKey),
      );
    },
    { env },
  );
}

async function restoreClaim(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
}): Promise<string | null> {
  const claimPath = `${params.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  try {
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, claimPath)))) {
      return null;
    }
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, params.sourcePath))) {
      return `source path already exists: ${params.sourcePath}`;
    }
    await params.stateRoot.move(
      relativeLegacyPath(params.stateDir, claimPath),
      relativeLegacyPath(params.stateDir, params.sourcePath),
    );
    return null;
  } catch (error) {
    return String(error);
  }
}

async function recoverInterruptedClaim(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  const claimPath = `${params.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  const claimRelativePath = relativeLegacyPath(params.stateDir, claimPath);
  if (!(await params.stateRoot.exists(claimRelativePath))) {
    return;
  }
  if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, params.sourcePath)))) {
    await params.stateRoot.move(
      claimRelativePath,
      relativeLegacyPath(params.stateDir, params.sourcePath),
    );
    return;
  }
  // Both paths can only be retired safely when the claimed bytes already have
  // an authoritative decision; otherwise preserve both for operator recovery.
  if (!hasMigrationReceipt(params.sourcePath, params.env)) {
    throw new Error("legacy restart sentinel source and interrupted claim both exist");
  }
  await readLegacySourceSnapshot(params.stateRoot, params.stateDir, claimPath);
  await params.stateRoot.remove(claimRelativePath);
}

function decisionChange(decision: MigrationDecision): string {
  switch (decision) {
    case "legacy-imported":
      return "Imported the legacy restart sentinel into shared SQLite state.";
    case "invalid-canonical-repaired":
      return "Replaced an invalid SQLite restart sentinel with validated legacy state.";
    case "canonical-preserved":
      return "Preserved the canonical SQLite restart sentinel and discarded conflicting legacy JSON.";
    case "malformed-legacy-discarded":
      return "Discarded malformed retired restart sentinel JSON without importing it.";
    case "receipt-authoritative":
      return "Discarded recreated retired restart sentinel JSON using its migration receipt.";
  }
  const unreachable: never = decision;
  return unreachable;
}

async function migrateWithExclusiveStateOwnership(params: {
  detected: LegacyRestartSentinelDetection;
  stateRoot: Root;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  const sourcePath = params.detected.sourcePath;
  try {
    await recoverInterruptedClaim({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      sourcePath,
      env: params.env,
    });
  } catch (error) {
    return {
      changes,
      warnings: [`Failed recovering a legacy restart sentinel Doctor claim: ${String(error)}`],
    };
  }
  if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath)))) {
    return { changes, warnings };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    snapshot = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, sourcePath);
  } catch (error) {
    return {
      changes,
      warnings: [`Failed reading the legacy restart sentinel: ${String(error)}`],
    };
  }
  const envelope = parseLegacyEnvelope(snapshot);
  const claimPath = `${sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  try {
    params.beforeVerify?.();
    const current = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, sourcePath);
    if (!snapshotsMatch(current, snapshot)) {
      throw new Error("legacy restart sentinel changed after migration loaded it");
    }
    params.beforeClaim?.();
    await params.stateRoot.move(
      relativeLegacyPath(params.stateDir, sourcePath),
      relativeLegacyPath(params.stateDir, claimPath),
    );
    const claimed = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, claimPath);
    if (!snapshotsMatch(claimed, snapshot)) {
      throw new Error("legacy restart sentinel changed before migration could claim it");
    }
  } catch (error) {
    const restoreError = await restoreClaim({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      sourcePath,
    });
    return {
      changes,
      warnings: [
        `Failed claiming the legacy restart sentinel: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  let result: ReturnType<typeof decideAndRecordMigration>;
  try {
    result = decideAndRecordMigration({
      env: params.env,
      sourcePath,
      snapshot,
      envelope,
    });
  } catch (error) {
    const restoreError = await restoreClaim({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      sourcePath,
    });
    return {
      changes,
      warnings: [
        `Failed migrating the legacy restart sentinel: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  try {
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath))) {
      throw new Error("legacy restart sentinel reappeared during migration cleanup");
    }
    if (params.removeSource) {
      await params.removeSource(claimPath);
    } else {
      await params.stateRoot.remove(relativeLegacyPath(params.stateDir, claimPath));
    }
    if (
      (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath))) ||
      (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, claimPath)))
    ) {
      throw new Error("legacy restart sentinel remains after migration cleanup");
    }
  } catch (error) {
    warnings.push(`Legacy restart sentinel cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  try {
    markSourceRemoved(result.sourceKey, params.env);
  } catch (error) {
    warnings.push(
      `Legacy restart sentinel was removed, but its receipt could not be finalized: ${String(error)}`,
    );
  }
  changes.push(decisionChange(result.decision));
  notices.push("Removed retired restart-sentinel.json after recording its migration decision.");
  return { changes, warnings, notices };
}

/** Import or retire the old file under exclusive state ownership. */
export async function migrateLegacyRestartSentinel(params: {
  detected?: LegacyRestartSentinelDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const detected = params.detected;
  if (!detected?.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  const env = { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: MIGRATION_LOCK_POLL_INTERVAL_MS,
      role: "sqlite-maintenance",
      timeoutMs: MIGRATION_LOCK_TIMEOUT_MS,
    });
  } catch (error) {
    const detail =
      error instanceof GatewayLockError
        ? "the Gateway or another SQLite maintenance command owns this state directory"
        : String(error);
    return {
      changes: [],
      warnings: [
        `Failed migrating the legacy restart sentinel: ${detail}. Stop the Gateway, then run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: [
        "Failed migrating the legacy restart sentinel: exclusive state ownership unavailable.",
      ],
    };
  }

  let result: MigrationMessages = { changes: [], warnings: [] };
  let releaseError: unknown;
  try {
    try {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_RESTART_SENTINEL_BYTES,
        symlinks: "reject",
      });
      result = await migrateWithExclusiveStateOwnership({
        ...params,
        detected,
        env,
        stateRoot,
      });
    } catch (error) {
      result.warnings.push(`Failed reading the legacy restart sentinel: ${String(error)}`);
    }
  } finally {
    try {
      await lock.release();
    } catch (error) {
      releaseError = error;
    }
  }
  if (releaseError) {
    result.warnings.push(
      `Restart sentinel migration lock release failed: ${formatErrorMessage(releaseError)}`,
    );
  }
  return result;
}

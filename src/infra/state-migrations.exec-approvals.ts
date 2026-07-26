// Doctor-only import for the retired exec approvals JSON store.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { root, type Root } from "@openclaw/fs-safe";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { formatErrorMessage } from "./errors.js";
import {
  resolveExecApprovalsPath,
  tryParsePersistedExecApprovals,
} from "./exec-approvals-config.js";
import { resetLegacyExecApprovalsPresenceCache } from "./exec-approvals-migration-gate.js";
import {
  readExecApprovalsConfigRow,
  serializeExecApprovals,
  writeExecApprovalsConfigRow,
} from "./exec-approvals-sqlite.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import type { LegacyExecApprovalsDetection } from "./state-migrations.exec-approvals.types.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const MAX_LEGACY_EXEC_APPROVALS_BYTES = 4 * 1024 * 1024;
const MIGRATION_KIND = "legacy-exec-approvals-json";
const TARGET_TABLE = "exec_approvals_config";
const MIGRATION_LOCK_TIMEOUT_MS = 250;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 25;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type ExecApprovalsMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "exec_approvals_config" | "migration_runs" | "migration_sources"
>;

type LegacySourceSnapshot = {
  buffer: Buffer;
  dev: number;
  ino: number;
  mtimeMs: number;
  raw: string | null;
  sha256: string;
  size: number;
};

type MigrationDecision =
  | "canonical-preserved"
  | "invalid-canonical-repaired"
  | "legacy-imported"
  | "malformed-legacy-preserved"
  | "receipt-authoritative";

function legacyPathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

/** Detect retired approvals only when an explicit Doctor flow opts in. */
export function detectLegacyExecApprovals(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyExecApprovalsDetection {
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const sourcePath = resolveExecApprovalsPath(env);
  const sourcePresent =
    legacyPathMayExist(sourcePath) || legacyPathMayExist(`${sourcePath}${DOCTOR_CLAIM_SUFFIX}`);
  return {
    sourcePath,
    hasLegacy: params.doctorOnlyStateMigrations === true && sourcePresent,
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
    throw new Error("legacy exec approvals path is outside the state directory");
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
    maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
    symlinks: "reject",
  });
  if (!opened.stat.isFile() || opened.stat.size !== opened.buffer.byteLength) {
    throw new Error("legacy exec approvals are not a stable regular file");
  }
  let raw: string | null = null;
  try {
    raw = utf8Decoder.decode(opened.buffer);
  } catch {
    // Invalid UTF-8 is malformed input that must stay available for recovery.
  }
  return {
    buffer: opened.buffer,
    dev: opened.stat.dev,
    ino: opened.stat.ino,
    mtimeMs: opened.stat.mtimeMs,
    raw,
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

function receiptSourceKey(sourcePath: string): string {
  return `exec-approvals-json:${createHash("sha256").update(path.resolve(sourcePath)).digest("hex")}`;
}

function decideAndRecordMigration(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
}): { decision: MigrationDecision; removeSource: boolean; sourceKey: string } {
  const sourceKey = receiptSourceKey(params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  const legacyFile =
    params.snapshot.raw === null ? null : tryParsePersistedExecApprovals(params.snapshot.raw);

  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<ExecApprovalsMigrationDatabase>(db);
      const canonical = readExecApprovalsConfigRow(db);
      const canonicalFile = canonical ? tryParsePersistedExecApprovals(canonical.raw_json) : null;
      const importedRaw = legacyFile ? serializeExecApprovals(legacyFile) : null;
      const receipt = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("migration_sources")
          .select(["source_sha256", "report_json"])
          .where("source_key", "=", sourceKey),
      );
      let receiptImportedSameSource = false;
      if (receipt?.source_sha256 === params.snapshot.sha256) {
        try {
          const report = JSON.parse(receipt.report_json) as { decision?: unknown };
          receiptImportedSameSource =
            report.decision === "legacy-imported" ||
            report.decision === "invalid-canonical-repaired" ||
            report.decision === "receipt-authoritative";
        } catch {
          // A malformed receipt is not authority to discard security state.
        }
      }
      let decision: MigrationDecision;
      let removeSource = false;
      if (!legacyFile || params.snapshot.raw === null) {
        decision = "malformed-legacy-preserved";
      } else if (receiptImportedSameSource && canonicalFile) {
        decision = "receipt-authoritative";
        removeSource = true;
      } else if (!canonical) {
        writeExecApprovalsConfigRow({
          db,
          file: legacyFile,
          raw: importedRaw ?? undefined,
          now,
        });
        decision = "legacy-imported";
        removeSource = true;
      } else if (!canonicalFile) {
        writeExecApprovalsConfigRow({
          db,
          file: legacyFile,
          raw: importedRaw ?? undefined,
          now,
        });
        decision = "invalid-canonical-repaired";
        removeSource = true;
      } else {
        decision = "canonical-preserved";
        removeSource = canonical.raw_json === params.snapshot.raw;
      }

      if (decision === "legacy-imported" || decision === "invalid-canonical-repaired") {
        if (!legacyFile) {
          throw new Error("exec approvals import decisions require a parsed legacy file");
        }
        const verified = readExecApprovalsConfigRow(db);
        const verifiedFile = verified ? tryParsePersistedExecApprovals(verified.raw_json) : null;
        const rawMatches = verified?.raw_json === importedRaw;
        const fileMatches =
          verifiedFile &&
          isDeepStrictEqual(
            JSON.parse(serializeExecApprovals(verifiedFile)),
            JSON.parse(serializeExecApprovals(legacyFile)),
          );
        if (!rawMatches || !fileMatches) {
          throw new Error(
            `SQLite verification failed for the exec approvals migration (raw=${rawMatches}, parsed=${Boolean(fileMatches)})`,
          );
        }
      }

      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: TARGET_TABLE,
        decision,
        sourceSha256: params.snapshot.sha256,
        sourceValid: legacyFile !== null,
        importedRecordCount:
          decision === "legacy-imported" || decision === "invalid-canonical-repaired" ? 1 : 0,
        preservedSqliteRecordCount:
          decision === "canonical-preserved" || decision === "receipt-authoritative" ? 1 : 0,
        removesSource: removeSource,
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
            target_table: TARGET_TABLE,
            source_sha256: params.snapshot.sha256,
            source_size_bytes: params.snapshot.size,
            source_record_count: legacyFile ? 1 : 0,
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
              source_record_count: legacyFile ? 1 : 0,
              last_run_id: runId,
              status: "completed",
              imported_at: now,
              removed_source: 0,
              report_json: reportJson,
            }),
          ),
      );
      return { decision, removeSource, sourceKey };
    },
    { env: params.env },
    { operationLabel: "state-migration.exec-approvals" },
  );
}

function markSourceRemoved(sourceKey: string, env: NodeJS.ProcessEnv): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<ExecApprovalsMigrationDatabase>(db)
          .updateTable("migration_sources")
          .set({ removed_source: 1 })
          .where("source_key", "=", sourceKey),
      );
    },
    { env },
    { operationLabel: "state-migration.exec-approvals.receipt" },
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
}): Promise<void> {
  const claimPath = `${params.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  const claimRelative = relativeLegacyPath(params.stateDir, claimPath);
  if (!(await params.stateRoot.exists(claimRelative))) {
    return;
  }
  const sourceRelative = relativeLegacyPath(params.stateDir, params.sourcePath);
  if (!(await params.stateRoot.exists(sourceRelative))) {
    await params.stateRoot.move(claimRelative, sourceRelative);
    return;
  }
  const [source, claim] = await Promise.all([
    readLegacySourceSnapshot(params.stateRoot, params.stateDir, params.sourcePath),
    readLegacySourceSnapshot(params.stateRoot, params.stateDir, claimPath),
  ]);
  if (source.sha256 !== claim.sha256 || source.size !== claim.size) {
    throw new Error("legacy exec approvals source and interrupted claim both exist");
  }
  await params.stateRoot.remove(claimRelative);
}

function decisionMessage(decision: MigrationDecision, removeSource: boolean): string {
  switch (decision) {
    case "legacy-imported":
      return "Imported legacy exec approvals into shared SQLite state.";
    case "invalid-canonical-repaired":
      return "Replaced an invalid SQLite exec approvals row with validated legacy state.";
    case "canonical-preserved":
      return removeSource
        ? "Preserved byte-identical canonical SQLite exec approvals."
        : "Preserved canonical SQLite exec approvals and retained conflicting legacy JSON.";
    case "malformed-legacy-preserved":
      return "Preserved malformed legacy exec approvals for operator recovery.";
    case "receipt-authoritative":
      return "Completed cleanup for previously imported legacy exec approvals.";
  }
  const unreachable: never = decision;
  return unreachable;
}

async function migrateWithExclusiveStateOwnership(params: {
  detected: LegacyExecApprovalsDetection;
  stateRoot: Root;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const sourcePath = params.detected.sourcePath;
  try {
    await recoverInterruptedClaim({ ...params, sourcePath });
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed recovering a legacy exec approvals Doctor claim: ${String(error)}`],
    };
  }
  const sourceRelative = relativeLegacyPath(params.stateDir, sourcePath);
  if (!(await params.stateRoot.exists(sourceRelative))) {
    return { changes: [], warnings: [] };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    snapshot = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, sourcePath);
  } catch (error) {
    return { changes: [], warnings: [`Failed reading legacy exec approvals: ${String(error)}`] };
  }

  const claimPath = `${sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  const claimRelative = relativeLegacyPath(params.stateDir, claimPath);
  try {
    params.beforeVerify?.();
    const current = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, sourcePath);
    if (!snapshotsMatch(current, snapshot)) {
      throw new Error("legacy exec approvals changed after migration loaded them");
    }
    params.beforeClaim?.();
    await params.stateRoot.move(sourceRelative, claimRelative);
    const claimed = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, claimPath);
    if (!snapshotsMatch(claimed, snapshot)) {
      throw new Error("legacy exec approvals changed before migration could claim them");
    }
  } catch (error) {
    const restoreError = await restoreClaim({ ...params, sourcePath });
    return {
      changes: [],
      warnings: [
        `Failed claiming legacy exec approvals: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  let result: ReturnType<typeof decideAndRecordMigration>;
  try {
    result = decideAndRecordMigration({
      env: params.env,
      sourcePath,
      snapshot,
    });
  } catch (error) {
    const restoreError = await restoreClaim({ ...params, sourcePath });
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy exec approvals: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  const preserveSource = !result.removeSource;
  if (preserveSource) {
    const restoreError = await restoreClaim({ ...params, sourcePath });
    return {
      changes: [],
      warnings: [
        `${decisionMessage(result.decision, result.removeSource)}${restoreError ? ` Claim restore failed: ${restoreError}` : ""}`,
      ],
    };
  }

  try {
    if (await params.stateRoot.exists(sourceRelative)) {
      throw new Error("legacy exec approvals reappeared during migration cleanup");
    }
    if (params.removeSource) {
      await params.removeSource(claimPath);
    } else {
      await params.stateRoot.remove(claimRelative);
    }
    if (
      (await params.stateRoot.exists(sourceRelative)) ||
      (await params.stateRoot.exists(claimRelative))
    ) {
      throw new Error("legacy exec approvals remain after migration cleanup");
    }
  } catch (error) {
    return {
      changes: [],
      warnings: [`Legacy exec approvals cleanup failed: ${String(error)}`],
    };
  }

  const warnings: string[] = [];
  try {
    markSourceRemoved(result.sourceKey, params.env);
  } catch (error) {
    warnings.push(
      `Legacy exec approvals were removed, but their receipt could not be finalized: ${String(error)}`,
    );
  }
  resetLegacyExecApprovalsPresenceCache(params.env);
  return {
    changes: [decisionMessage(result.decision, result.removeSource)],
    warnings,
    notices: ["Removed retired exec approvals JSON after recording its migration decision."],
  };
}

/** Import or retire the old file under exclusive state ownership. */
export async function migrateLegacyExecApprovals(params: {
  detected?: LegacyExecApprovalsDetection;
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
        `Failed migrating legacy exec approvals: ${detail}. Stop the Gateway, then run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: ["Failed migrating legacy exec approvals: exclusive state ownership unavailable."],
    };
  }

  let result: MigrationMessages = { changes: [], warnings: [] };
  let releaseError: unknown;
  try {
    try {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
        symlinks: "reject",
      });
      result = await migrateWithExclusiveStateOwnership({
        ...params,
        detected,
        env,
        stateRoot,
      });
    } catch (error) {
      result.warnings.push(`Failed reading legacy exec approvals: ${String(error)}`);
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
      `Exec approvals migration lock release failed: ${formatErrorMessage(releaseError)}`,
    );
  }
  return result;
}

// Doctor-only removal for the retired commitments JSON store.
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  openExistingOpenClawStateDatabaseReadOnly,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceipt,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import {
  LegacyMigrationSourceClaim,
  legacyMigrationSourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_COMMITMENTS_PATH = "commitments/commitments.json";
const DOCTOR_CLAIM_SUFFIX = ".doctor-discarding";
const MAX_LEGACY_COMMITMENTS_BYTES = 16 * 1024 * 1024;
const MIGRATION_KIND = "legacy-commitments-json";
const LEGACY_STORE_KEYS = new Set(["version", "commitments"]);
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type LegacyCommitmentsSnapshot = LegacyMigrationSourceSnapshot & {
  recordCount: number;
};

function resolveLegacyCommitmentsPath(stateDir: string): string {
  return path.join(stateDir, LEGACY_COMMITMENTS_PATH);
}

/** Detect the exact retired store only when an explicit Doctor flow opts in. */
export async function detectLegacyCommitments(params: {
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  doctorOnlyStateMigrations?: boolean;
}): Promise<NonNullable<LegacyStateDetection["commitments"]>> {
  const sourcePath = resolveLegacyCommitmentsPath(params.stateDir);
  let hasPendingReceipt = false;
  if (
    params.doctorOnlyStateMigrations === true &&
    !legacyMigrationSourceOrClaimMayExist(sourcePath, DOCTOR_CLAIM_SUFFIX)
  ) {
    try {
      const database = await openExistingOpenClawStateDatabaseReadOnly({ env: params.env });
      try {
        const receipt = database
          ? readLegacyMigrationReceiptFromDatabase(
              database.db,
              resolveLegacyMigrationSourceKey("commitments-json", sourcePath),
            )
          : null;
        hasPendingReceipt = receipt !== null && !receipt.removedSource;
      } finally {
        database?.walMaintenance.close();
      }
    } catch {
      // Detection must not replace the schema repair diagnostics for an older or unhealthy DB.
    }
  }
  return {
    sourcePath,
    hasLegacy:
      params.doctorOnlyStateMigrations === true &&
      (legacyMigrationSourceOrClaimMayExist(sourcePath, DOCTOR_CLAIM_SUFFIX) || hasPendingReceipt),
  };
}

function parseLegacyCommitments(buffer: Buffer): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(utf8Decoder.decode(buffer));
  } catch {
    throw new Error("retired commitments store is not valid UTF-8 JSON");
  }
  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.commitments) ||
    Object.keys(parsed).some((key) => !LEGACY_STORE_KEYS.has(key))
  ) {
    throw new Error(
      "retired commitments store must contain only version 1 and a commitments array",
    );
  }
  return parsed.commitments.length;
}

async function readLegacyCommitmentsSnapshot(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
}): Promise<LegacyCommitmentsSnapshot> {
  const snapshot = await readLegacyMigrationSourceSnapshot({
    ...params,
    maxBytes: MAX_LEGACY_COMMITMENTS_BYTES,
    label: "commitments",
  });
  return { ...snapshot, recordCount: parseLegacyCommitments(snapshot.buffer) };
}

function recordDiscardDecision(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacyCommitmentsSnapshot;
}): { recreated: boolean; sourceKey: string } {
  const sourceKey = resolveLegacyMigrationSourceKey("commitments-json", params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  let recreated = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      recreated = readLegacyMigrationReceiptFromDatabase(db, sourceKey)?.removedSource === true;
      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: null,
        decision: "retired-source-discarded",
        sourceSha256: params.snapshot.sha256,
        sourceRecordCount: params.snapshot.recordCount,
        importedRecordCount: 0,
        archivedRecordCount: 0,
        exportedRecordCount: 0,
      });
      recordLegacyMigrationReceipt(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: params.sourcePath,
        targetTable: "commitments",
        sourceSha256: params.snapshot.sha256,
        sourceSizeBytes: params.snapshot.size,
        sourceRecordCount: params.snapshot.recordCount,
        runId,
        now,
        reportJson,
        upsert: true,
      });
    },
    { env: params.env },
    { operationLabel: "state-migration.commitments" },
  );
  return { recreated, sourceKey };
}

async function migrateWithExclusiveStateOwnership(params: {
  stateRoot: Root;
  detected: NonNullable<LegacyStateDetection["commitments"]>;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const sourcePath = params.detected.sourcePath;
  const sourceKey = resolveLegacyMigrationSourceKey("commitments-json", sourcePath);
  const source = new LegacyMigrationSourceClaim<LegacyCommitmentsSnapshot>({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath,
    label: "commitments",
    claimSuffix: DOCTOR_CLAIM_SUFFIX,
    readSnapshot: (candidate) =>
      readLegacyCommitmentsSnapshot({
        stateRoot: params.stateRoot,
        stateDir: params.stateDir,
        sourcePath: candidate,
      }),
  });
  try {
    await source.recover("retired commitments source conflicts with its interrupted Doctor claim");
    if (!(await source.exists())) {
      const receipt = readLegacyMigrationReceipt(sourceKey, params.env);
      if (receipt && !receipt.removedSource) {
        try {
          markLegacyMigrationSourceRemoved(sourceKey, params.env, "state-migration.commitments");
          return {
            changes: ["Finalized the retired commitments JSON discard receipt."],
            warnings: [],
          };
        } catch (error) {
          return {
            changes: [],
            warnings: [
              `Retired commitments JSON was removed, but its receipt could not be finalized: ${String(error)}`,
            ],
          };
        }
      }
      return { changes: [], warnings: [] };
    }
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed recovering retired commitments JSON: ${String(error)}`],
    };
  }

  let snapshot: LegacyCommitmentsSnapshot;
  try {
    snapshot = await source.read();
    params.beforeVerify?.();
    if (!legacyMigrationSourceSnapshotsMatch(snapshot, await source.read())) {
      throw new Error("retired commitments source changed after Doctor loaded it");
    }
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed reading retired commitments JSON: ${String(error)}`],
    };
  }

  try {
    await source.claim({
      snapshot,
      mismatchMessage: "retired commitments source changed before Doctor could claim it",
      beforeClaim: params.beforeClaim,
    });
  } catch (error) {
    const restoreError = await source.restore();
    return {
      changes: [],
      warnings: [
        `Failed claiming retired commitments JSON: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  let decision: ReturnType<typeof recordDiscardDecision>;
  try {
    decision = recordDiscardDecision({
      env: params.env,
      sourcePath,
      snapshot,
    });
  } catch (error) {
    const restoreError = await source.restore();
    return {
      changes: [],
      warnings: [
        `Failed recording retired commitments discard: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  try {
    if (!legacyMigrationSourceSnapshotsMatch(snapshot, await source.read(true))) {
      throw new Error("retired commitments Doctor claim changed before cleanup");
    }
    await source.remove({
      removeSource: params.removeSource,
      sourceReappearedMessage: "retired commitments source reappeared during cleanup",
      sourceRemainingMessage: "retired commitments source remains after cleanup",
      claimRemainingMessage: "retired commitments Doctor claim remains after cleanup",
    });
  } catch (error) {
    return {
      changes: [],
      warnings: [`Retired commitments discard was recorded, but cleanup failed: ${String(error)}`],
    };
  }

  const warnings: string[] = [];
  try {
    markLegacyMigrationSourceRemoved(decision.sourceKey, params.env, "state-migration.commitments");
  } catch (error) {
    warnings.push(
      `Retired commitments JSON was removed, but its receipt could not be finalized: ${String(error)}`,
    );
  }
  const rowLabel = snapshot.recordCount === 1 ? "row" : "rows";
  return {
    changes: [
      decision.recreated
        ? `Discarded recreated retired commitments JSON with ${snapshot.recordCount} ${rowLabel}; no data was imported, archived, or exported.`
        : `Discarded retired commitments JSON with ${snapshot.recordCount} ${rowLabel}; no data was imported, archived, or exported.`,
    ],
    warnings,
  };
}

/** Discard retired persistent state while excluding active Gateway owners. */
export async function migrateLegacyCommitments(params: {
  detected: NonNullable<LegacyStateDetection["commitments"]>;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "retired commitments JSON",
    releaseLabel: "Commitments",
    errorLabel: "Failed retiring commitments JSON",
    retryGuidance: "Stop the Gateway, then run `openclaw doctor --fix` again.",
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_COMMITMENTS_BYTES,
        symlinks: "reject",
      });
      return await migrateWithExclusiveStateOwnership({ ...params, env, stateRoot });
    },
  });
}

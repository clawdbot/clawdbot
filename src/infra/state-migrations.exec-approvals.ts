// Doctor-only import for the retired exec approvals JSON store.
import { isDeepStrictEqual } from "node:util";
import { root, type Root } from "@openclaw/fs-safe";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
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
import type { LegacyExecApprovalsDetection } from "./state-migrations.exec-approvals.types.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
} from "./state-migrations.receipts.js";
import {
  legacyMigrationSourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch as snapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  resolveLegacyMigrationRelativePath,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const MAX_LEGACY_EXEC_APPROVALS_BYTES = 4 * 1024 * 1024;
const MIGRATION_KIND = "legacy-exec-approvals-json";
const TARGET_TABLE = "exec_approvals_config";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

type LegacySourceSnapshot = Omit<LegacyMigrationSourceSnapshot, "raw"> & { raw: string | null };

type MigrationDecision =
  | "canonical-preserved"
  | "invalid-canonical-repaired"
  | "legacy-imported"
  | "malformed-legacy-preserved"
  | "receipt-authoritative";

/** Detect retired approvals only when an explicit Doctor flow opts in. */
export function detectLegacyExecApprovals(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyExecApprovalsDetection {
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  const sourcePath = resolveExecApprovalsPath(env);
  const sourcePresent = legacyMigrationSourceOrClaimMayExist(sourcePath, DOCTOR_CLAIM_SUFFIX);
  return {
    sourcePath,
    hasLegacy: params.doctorOnlyStateMigrations === true && sourcePresent,
  };
}

function relativeLegacyPath(stateDir: string, filePath: string): string {
  return resolveLegacyMigrationRelativePath(stateDir, filePath, "exec approvals", false);
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
): Promise<LegacySourceSnapshot> {
  const snapshot = await readLegacyMigrationSourceSnapshot({
    stateRoot,
    stateDir,
    sourcePath,
    maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
    label: "exec approvals",
  });
  let raw: string | null = null;
  try {
    raw = utf8Decoder.decode(snapshot.buffer);
  } catch {
    // Invalid UTF-8 is malformed input that must stay available for recovery.
  }
  return { ...snapshot, raw };
}

function decideAndRecordMigration(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
}): { decision: MigrationDecision; removeSource: boolean; sourceKey: string } {
  const sourceKey = resolveLegacyMigrationSourceKey("exec-approvals-json", params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  const legacyFile =
    params.snapshot.raw === null ? null : tryParsePersistedExecApprovals(params.snapshot.raw);

  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const canonical = readExecApprovalsConfigRow(db);
      const canonicalFile = canonical ? tryParsePersistedExecApprovals(canonical.raw_json) : null;
      const importedRaw = legacyFile ? serializeExecApprovals(legacyFile) : null;
      const receipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
      let receiptImportedSameSource = false;
      if (receipt?.sourceSha256 === params.snapshot.sha256) {
        try {
          const report = JSON.parse(receipt.reportJson) as { decision?: unknown };
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
      recordLegacyMigrationReceipt(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: params.sourcePath,
        targetTable: TARGET_TABLE,
        sourceSha256: params.snapshot.sha256,
        sourceSizeBytes: params.snapshot.size,
        sourceRecordCount: legacyFile ? 1 : 0,
        runId,
        now,
        reportJson,
        upsert: true,
      });
      return { decision, removeSource, sourceKey };
    },
    { env: params.env },
    { operationLabel: "state-migration.exec-approvals" },
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
    markLegacyMigrationSourceRemoved(
      result.sourceKey,
      params.env,
      "state-migration.exec-approvals.receipt",
    );
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
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy exec approvals",
    releaseLabel: "Exec approvals",
    errorLabel: "Failed reading legacy exec approvals",
    retryGuidance: "Stop the Gateway, then run `openclaw doctor --fix` again.",
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: MAX_LEGACY_EXEC_APPROVALS_BYTES,
        symlinks: "reject",
      });
      return await migrateWithExclusiveStateOwnership({
        ...params,
        detected,
        env,
        stateRoot,
      });
    },
  });
}

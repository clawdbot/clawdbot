// Doctor-only import for the retired exec approvals JSON store.
import { isDeepStrictEqual } from "node:util";
import { root, type Root } from "@openclaw/fs-safe";
import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  resolveExecApprovalsPath,
  tryParsePersistedExecApprovals,
} from "./exec-approvals-config.js";
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
  LegacyMigrationSourceClaim,
  legacyMigrationSourceOrClaimMayExist,
  legacyMigrationSourceSnapshotsMatch as snapshotsMatch,
  readLegacyMigrationSourceSnapshot,
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

function normalizeLegacyNullableUsageMetadata(raw: string): string {
  const parsed = safeParseJsonRecord(raw);
  if (!parsed || !isRecord(parsed.agents)) {
    return raw;
  }

  let changed = false;
  for (const agent of Object.values(parsed.agents)) {
    if (!isRecord(agent) || !Array.isArray(agent.allowlist)) {
      continue;
    }
    for (const entry of agent.allowlist) {
      if (!isRecord(entry)) {
        continue;
      }
      // Legacy files can contain null usage metadata. Repair only these fields at
      // import so canonical policy validation remains strict.
      for (const key of ["lastUsedAt", "lastUsedCommand"]) {
        if (entry[key] === null) {
          delete entry[key];
          changed = true;
        }
      }
    }
  }
  return changed ? JSON.stringify(parsed) : raw;
}

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
    params.snapshot.raw === null
      ? null
      : tryParsePersistedExecApprovals(normalizeLegacyNullableUsageMetadata(params.snapshot.raw));

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
  const source = new LegacyMigrationSourceClaim<LegacySourceSnapshot>({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath,
    label: "exec approvals",
    includeFilePath: false,
    claimSuffix: DOCTOR_CLAIM_SUFFIX,
    readSnapshot: (snapshotPath) =>
      readLegacySourceSnapshot(params.stateRoot, params.stateDir, snapshotPath),
  });
  try {
    await source.recover("legacy exec approvals source and interrupted claim both exist");
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed recovering a legacy exec approvals Doctor claim: ${String(error)}`],
    };
  }
  if (!(await source.exists())) {
    return { changes: [], warnings: [] };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    snapshot = await source.read();
  } catch (error) {
    return { changes: [], warnings: [`Failed reading legacy exec approvals: ${String(error)}`] };
  }

  try {
    params.beforeVerify?.();
    const current = await source.read();
    if (!snapshotsMatch(current, snapshot)) {
      throw new Error("legacy exec approvals changed after migration loaded them");
    }
    await source.claim({
      snapshot,
      mismatchMessage: "legacy exec approvals changed before migration could claim them",
      beforeClaim: params.beforeClaim,
    });
  } catch (error) {
    const restoreError = await source.restore();
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
    const restoreError = await source.restore();
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy exec approvals: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  if (!result.removeSource) {
    const restoreError = await source.restore();
    return {
      changes: [],
      warnings: [
        `${decisionMessage(result.decision, result.removeSource)}${restoreError ? ` Claim restore failed: ${restoreError}` : ""}`,
      ],
    };
  }

  try {
    await source.remove({
      removeSource: params.removeSource,
      sourceReappearedMessage: "legacy exec approvals reappeared during migration cleanup",
      remainingMessage: "legacy exec approvals remain after migration cleanup",
    });
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

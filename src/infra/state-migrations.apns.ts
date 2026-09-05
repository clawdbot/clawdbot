// Doctor-only import for the retired APNs registration JSON store.
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { readLegacyJsonObjectStream } from "./legacy-json-object-stream.js";
import {
  apnsRegistrationFromRow,
  apnsRegistrationToRow,
  isValidApnsNodeId,
  normalizeApnsEnvironment,
  normalizeApnsNodeId,
  normalizeCanonicalApnsRegistration,
  type ApnsRegistration,
} from "./push-apns-store.js";
import { assertAllowedJsonFields } from "./state-migrations.json-fields.js";
import { withLegacyMigrationStateLock } from "./state-migrations.lock.js";
import {
  markLegacyMigrationSourceRemoved,
  readLegacyMigrationReceipt,
  readLegacyMigrationReceiptFromDatabase,
  recordLegacyMigrationReceipt,
  resolveLegacyMigrationSourceKey,
  type LegacyMigrationReceipt,
} from "./state-migrations.receipts.js";
import {
  LegacyMigrationSourceClaim,
  legacyMigrationSourceOrClaimMayExist,
  resolveLegacyMigrationRelativePath,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_APNS_REGISTRATION_PATH = "push/apns-registrations.json";
const APNS_DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const MIGRATION_KIND = "legacy-apns-registrations-json";
// Legacy values are wall-clock timestamps. Bounding them to ECMAScript Date's
// finite range rejects hostile counters with ~367 trillion successor values left.
const MAX_LEGACY_APNS_UPDATED_AT_MS = 8_640_000_000_000_000;
const DIRECT_REGISTRATION_KEYS = new Set([
  "nodeId",
  "transport",
  "token",
  "topic",
  "environment",
  "updatedAtMs",
]);
const RELAY_REGISTRATION_KEYS = new Set([
  "nodeId",
  "transport",
  "relayHandle",
  "sendGrant",
  "installationId",
  "topic",
  "environment",
  "distribution",
  "updatedAtMs",
  "relayOrigin",
  "tokenDebugSuffix",
]);

type ApnsMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "apns_registrations" | "apns_registration_tombstones"
>;

type LegacySourceSnapshot = Pick<
  LegacyMigrationSourceSnapshot,
  "sourcePath" | "dev" | "ino" | "mtimeMs" | "sha256" | "size"
>;

function resolveLegacyApnsPath(stateDir: string): string {
  return path.join(stateDir, LEGACY_APNS_REGISTRATION_PATH);
}

/** Detect the retired APNs store only when an explicit Doctor flow opts in. */
export function detectLegacyApnsRegistrations(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["apns"] {
  const sourcePath = resolveLegacyApnsPath(params.stateDir);
  return {
    sourcePath,
    hasLegacy:
      params.doctorOnlyStateMigrations === true &&
      legacyMigrationSourceOrClaimMayExist(sourcePath, APNS_DOCTOR_CLAIM_SUFFIX),
  };
}

function relativeLegacyPath(stateDir: string, filePath: string): string {
  return resolveLegacyMigrationRelativePath(stateDir, filePath, "APNs", false);
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
  onEntry?: (key: string, value: unknown) => void,
): Promise<LegacySourceSnapshot> {
  const snapshot = await readLegacyJsonObjectStream({
    stateRoot,
    relativePath: relativeLegacyPath(stateDir, sourcePath),
    ...(onEntry ? { property: "registrationsByNodeId", onEntry } : {}),
  });
  return {
    sourcePath,
    ...snapshot,
  };
}

function isValidLegacyApnsTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= MAX_LEGACY_APNS_UPDATED_AT_MS
  );
}

function parseLegacyApnsRegistration(
  rawNodeId: string,
  rawRegistration: unknown,
  env: NodeJS.ProcessEnv,
): [string, ApnsRegistration] {
  if (!isRecord(rawRegistration)) {
    throw new Error("legacy APNs registration is not an object");
  }
  const transport = rawRegistration.transport ?? "direct";
  if (transport !== "direct" && transport !== "relay") {
    throw new Error("legacy APNs registration has invalid transport");
  }
  assertAllowedJsonFields(
    rawRegistration,
    transport === "relay" ? RELAY_REGISTRATION_KEYS : DIRECT_REGISTRATION_KEYS,
    "legacy APNs registration",
    { reportField: false },
  );
  const normalizedNodeId = normalizeApnsNodeId(rawNodeId);
  if (!isValidApnsNodeId(normalizedNodeId)) {
    throw new Error("legacy APNs registration has an invalid node id");
  }
  if (!isValidLegacyApnsTimestamp(rawRegistration.updatedAtMs)) {
    throw new Error("legacy APNs registration has an invalid updated timestamp");
  }
  const candidate =
    transport === "direct"
      ? {
          ...rawRegistration,
          transport,
          environment: normalizeApnsEnvironment(rawRegistration.environment) ?? "sandbox",
        }
      : { ...rawRegistration, transport };
  const registration = normalizeCanonicalApnsRegistration(candidate, env);
  const invalidRelayOrigin =
    transport === "relay" &&
    Object.hasOwn(rawRegistration, "relayOrigin") &&
    (!registration || registration.transport !== "relay" || !registration.relayOrigin);
  const invalidTokenDebugSuffix =
    transport === "relay" &&
    Object.hasOwn(rawRegistration, "tokenDebugSuffix") &&
    typeof rawRegistration.tokenDebugSuffix !== "string";
  if (
    !registration ||
    registration.nodeId !== normalizedNodeId ||
    invalidRelayOrigin ||
    invalidTokenDebugSuffix
  ) {
    throw new Error("legacy APNs registration is invalid");
  }
  return [normalizedNodeId, registration];
}

function importAndRecordReceipt(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
  registrations: ReadonlyMap<string, ApnsRegistration>;
}): {
  sourceKey: string;
  imported: number;
  preserved: number;
  suppressed: number;
  receiptAuthoritative: boolean;
} {
  const sourceKey = resolveLegacyMigrationSourceKey("apns-json", params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<ApnsMigrationDatabase>(db);
      const existingReceipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
      if (existingReceipt) {
        return {
          sourceKey,
          imported: 0,
          preserved: 0,
          suppressed: 0,
          receiptAuthoritative: true,
        };
      }

      let imported = 0;
      let preserved = 0;
      let suppressed = 0;
      const expectedNodeIds: string[] = [];
      for (const [nodeId, registration] of params.registrations) {
        const existing = executeSqliteQueryTakeFirstSync(
          db,
          stateDb.selectFrom("apns_registrations").selectAll().where("node_id", "=", nodeId),
        );
        const tombstone = executeSqliteQueryTakeFirstSync(
          db,
          stateDb
            .selectFrom("apns_registration_tombstones")
            .select("node_id")
            .where("node_id", "=", nodeId),
        );
        if (existing && tombstone) {
          throw new Error("APNs state has both a registration and deletion tombstone");
        }
        if (existing) {
          // SQLite is already canonical. Never let a stale retired file replace a
          // registration created or invalidated by the current runtime.
          apnsRegistrationFromRow(existing);
          preserved += 1;
          expectedNodeIds.push(nodeId);
        } else if (tombstone) {
          suppressed += 1;
        } else {
          executeSqliteQuerySync(
            db,
            stateDb.insertInto("apns_registrations").values(apnsRegistrationToRow(registration)),
          );
          imported += 1;
          expectedNodeIds.push(nodeId);
        }
      }

      for (const nodeId of expectedNodeIds) {
        const verified = executeSqliteQueryTakeFirstSync(
          db,
          stateDb.selectFrom("apns_registrations").selectAll().where("node_id", "=", nodeId),
        );
        if (!verified) {
          throw new Error("SQLite verification failed for an APNs registration");
        }
        apnsRegistrationFromRow(verified);
      }

      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: "apns_registrations",
        sourceSha256: params.snapshot.sha256,
        sourceRecordCount: params.registrations.size,
        importedRecordCount: imported,
        preservedSqliteRecordCount: preserved,
        suppressedDeletedRecordCount: suppressed,
      });
      recordLegacyMigrationReceipt(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: params.sourcePath,
        targetTable: "apns_registrations",
        sourceSha256: params.snapshot.sha256,
        sourceSizeBytes: params.snapshot.size,
        sourceRecordCount: params.registrations.size,
        runId,
        now,
        reportJson,
      });
      return { sourceKey, imported, preserved, suppressed, receiptAuthoritative: false };
    },
    { env: params.env },
  );
}

async function cleanupReceiptAuthoritativeSources(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  receipt: LegacyMigrationReceipt;
  env: NodeJS.ProcessEnv;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<number> {
  let removed = 0;
  for (const candidate of [params.sourcePath, `${params.sourcePath}${APNS_DOCTOR_CLAIM_SUFFIX}`]) {
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, candidate)))) {
      continue;
    }
    // Validate ownership and drain the pinned inode before deleting receipt-retired bytes.
    await readLegacySourceSnapshot(params.stateRoot, params.stateDir, candidate);
    if (params.removeSource) {
      await params.removeSource(candidate);
    } else {
      await params.stateRoot.remove(relativeLegacyPath(params.stateDir, candidate));
    }
    removed += 1;
  }
  if (!params.receipt.removedSource || removed > 0) {
    markLegacyMigrationSourceRemoved(params.receipt.sourceKey, params.env);
  }
  return removed;
}

async function migrateWithExclusiveStateOwnership(params: {
  stateRoot: Root;
  detected: LegacyStateDetection["apns"];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  const receipt = readLegacyMigrationReceipt(
    resolveLegacyMigrationSourceKey("apns-json", params.detected.sourcePath),
    params.env,
  );
  if (receipt) {
    try {
      const removed = await cleanupReceiptAuthoritativeSources({
        ...params,
        sourcePath: params.detected.sourcePath,
        receipt,
      });
      if (removed > 0) {
        notices.push("Discarded retired APNs JSON state already covered by its SQLite receipt.");
      }
    } catch (error) {
      warnings.push(`APNs state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    }
    return notices.length > 0 ? { changes, warnings, notices } : { changes, warnings };
  }

  const sourcePath = params.detected.sourcePath;
  const source = new LegacyMigrationSourceClaim<LegacySourceSnapshot>({
    stateRoot: params.stateRoot,
    stateDir: params.stateDir,
    sourcePath,
    label: "APNs",
    includeFilePath: false,
    claimSuffix: APNS_DOCTOR_CLAIM_SUFFIX,
    readSnapshot: (snapshotPath) =>
      readLegacySourceSnapshot(params.stateRoot, params.stateDir, snapshotPath),
  });
  const hasSource = await source.exists();
  const hasClaim = await source.exists(true);
  if (hasSource && hasClaim) {
    return {
      changes,
      warnings: ["Failed migrating legacy APNs state: source and interrupted claim both exist."],
    };
  }
  const activePath = hasSource ? sourcePath : hasClaim ? source.claimPath : null;
  if (!activePath) {
    return { changes, warnings };
  }

  let snapshot: LegacySourceSnapshot;
  const registrations = new Map<string, ApnsRegistration>();
  try {
    snapshot = await readLegacySourceSnapshot(
      params.stateRoot,
      params.stateDir,
      activePath,
      (rawNodeId, rawRegistration) => {
        const [nodeId, registration] = parseLegacyApnsRegistration(
          rawNodeId,
          rawRegistration,
          params.env,
        );
        if (registrations.has(nodeId)) {
          throw new Error("legacy APNs registration has a duplicate node id");
        }
        registrations.set(nodeId, registration);
      },
    );
  } catch (error) {
    warnings.push(`Failed reading legacy APNs state: ${String(error)}`);
    return { changes, warnings };
  }

  if (activePath === sourcePath) {
    try {
      snapshot = await source.claim({
        snapshot,
        mismatchMessage: "legacy APNs source changed before Doctor could claim it",
        beforeClaim: params.beforeClaim,
      });
    } catch (error) {
      const restoreError = await source.restore();
      warnings.push(
        `Failed migrating legacy APNs state: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      );
      return { changes, warnings };
    }
  }

  let result: ReturnType<typeof importAndRecordReceipt>;
  try {
    result = importAndRecordReceipt({
      env: params.env,
      sourcePath,
      snapshot,
      registrations,
    });
  } catch (error) {
    const restoreError = await source.restore();
    warnings.push(
      `Failed migrating legacy APNs state: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  try {
    await source.remove({
      removeSource: params.removeSource,
      sourceReappearedMessage: "legacy APNs source reappeared during import",
    });
    markLegacyMigrationSourceRemoved(result.sourceKey, params.env);
  } catch (error) {
    warnings.push(`APNs state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  changes.push(
    `Migrated ${result.imported} APNs registration${result.imported === 1 ? "" : "s"} to SQLite.`,
  );
  if (result.preserved > 0) {
    notices.push(
      `Preserved ${result.preserved} canonical SQLite APNs registration${result.preserved === 1 ? "" : "s"}.`,
    );
  }
  if (result.suppressed > 0) {
    notices.push(
      `Kept ${result.suppressed} deleted APNs registration${result.suppressed === 1 ? "" : "s"} retired.`,
    );
  }
  notices.push("Removed retired APNs JSON state after verified SQLite import.");
  return { changes, warnings, notices };
}

/** Import the retired APNs store while excluding old Gateways that can recreate it. */
export async function migrateLegacyApnsRegistrations(params: {
  detected: LegacyStateDetection["apns"];
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy) {
    return { changes: [], warnings: [] };
  }

  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy APNs state",
    releaseLabel: "APNs",
    errorLabel: "Failed reading legacy APNs state",
    run: async (env) => {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        symlinks: "reject",
      });
      return await migrateWithExclusiveStateOwnership({
        ...params,
        env,
        stateRoot,
      });
    },
  });
}

// Doctor-only import for the retired APNs registration JSON store.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
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
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";

const LEGACY_APNS_REGISTRATION_PATH = "push/apns-registrations.json";
const APNS_DOCTOR_CLAIM_SUFFIX = ".doctor-importing";
const MIGRATION_KIND = "legacy-apns-registrations-json";
const MIGRATION_LOCK_TIMEOUT_MS = 250;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 25;
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
  "apns_registrations" | "apns_registration_tombstones" | "migration_runs" | "migration_sources"
>;

type LegacySourceSnapshot = {
  sourcePath: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  size: number;
};

type MigrationReceipt = {
  sourceKey: string;
  removedSource: boolean;
};

function resolveLegacyApnsPath(stateDir: string): string {
  return path.join(stateDir, LEGACY_APNS_REGISTRATION_PATH);
}

function legacyPathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function sourceOrClaimMayExist(sourcePath: string): boolean {
  return (
    legacyPathMayExist(sourcePath) || legacyPathMayExist(`${sourcePath}${APNS_DOCTOR_CLAIM_SUFFIX}`)
  );
}

/** Detect the retired APNs store only when an explicit Doctor flow opts in. */
export function detectLegacyApnsRegistrations(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["apns"] {
  const sourcePath = resolveLegacyApnsPath(params.stateDir);
  return {
    sourcePath,
    hasLegacy: params.doctorOnlyStateMigrations === true && sourceOrClaimMayExist(sourcePath),
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
    throw new Error("legacy APNs path is outside the state directory");
  }
  return relativePath;
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

function snapshotsMatch(left: LegacySourceSnapshot, right: LegacySourceSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected) {
    throw new Error("legacy APNs registration has an unexpected field");
  }
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
  assertOnlyKeys(
    rawRegistration,
    transport === "relay" ? RELAY_REGISTRATION_KEYS : DIRECT_REGISTRATION_KEYS,
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

function receiptSourceKey(sourcePath: string): string {
  return `apns-json:${createHash("sha256").update(path.resolve(sourcePath)).digest("hex")}`;
}

function readMigrationReceipt(sourcePath: string, env: NodeJS.ProcessEnv): MigrationReceipt | null {
  const sourceKey = receiptSourceKey(sourcePath);
  const { db } = openOpenClawStateDatabase({ env });
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<ApnsMigrationDatabase>(db)
      .selectFrom("migration_sources")
      .select("removed_source")
      .where("source_key", "=", sourceKey),
  );
  return row ? { sourceKey, removedSource: row.removed_source === 1 } : null;
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
  const sourceKey = receiptSourceKey(params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<ApnsMigrationDatabase>(db);
      const existingReceipt = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("migration_sources")
          .select("source_key")
          .where("source_key", "=", sourceKey),
      );
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
      executeSqliteQuerySync(
        db,
        stateDb.insertInto("migration_runs").values({
          id: runId,
          started_at: now,
          finished_at: now,
          status: "completed",
          report_json: reportJson,
        }),
      );
      executeSqliteQuerySync(
        db,
        stateDb.insertInto("migration_sources").values({
          source_key: sourceKey,
          migration_kind: MIGRATION_KIND,
          source_path: params.sourcePath,
          target_table: "apns_registrations",
          source_sha256: params.snapshot.sha256,
          source_size_bytes: params.snapshot.size,
          source_record_count: params.registrations.size,
          last_run_id: runId,
          status: "completed",
          imported_at: now,
          removed_source: 0,
          report_json: reportJson,
        }),
      );
      return { sourceKey, imported, preserved, suppressed, receiptAuthoritative: false };
    },
    { env: params.env },
  );
}

function markSourceRemoved(sourceKey: string, env: NodeJS.ProcessEnv): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<ApnsMigrationDatabase>(db)
          .updateTable("migration_sources")
          .set({ removed_source: 1 })
          .where("source_key", "=", sourceKey),
      );
    },
    { env },
  );
}

async function removePath(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<void> {
  if (params.removeSource) {
    await params.removeSource(params.sourcePath);
    return;
  }
  await params.stateRoot.remove(relativeLegacyPath(params.stateDir, params.sourcePath));
}

async function cleanupReceiptAuthoritativeSources(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  receipt: MigrationReceipt;
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
    await removePath({ ...params, sourcePath: candidate });
    removed += 1;
  }
  if (!params.receipt.removedSource || removed > 0) {
    markSourceRemoved(params.receipt.sourceKey, params.env);
  }
  return removed;
}

async function restoreClaim(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
}): Promise<string | null> {
  const claimPath = `${params.sourcePath}${APNS_DOCTOR_CLAIM_SUFFIX}`;
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

  const receipt = readMigrationReceipt(params.detected.sourcePath, params.env);
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
  const claimPath = `${sourcePath}${APNS_DOCTOR_CLAIM_SUFFIX}`;
  const hasSource = await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath));
  const hasClaim = await params.stateRoot.exists(relativeLegacyPath(params.stateDir, claimPath));
  if (hasSource && hasClaim) {
    return {
      changes,
      warnings: ["Failed migrating legacy APNs state: source and interrupted claim both exist."],
    };
  }
  const activePath = hasSource ? sourcePath : hasClaim ? claimPath : null;
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
      params.beforeClaim?.();
      await params.stateRoot.move(
        relativeLegacyPath(params.stateDir, sourcePath),
        relativeLegacyPath(params.stateDir, claimPath),
      );
      const claimed = await readLegacySourceSnapshot(params.stateRoot, params.stateDir, claimPath);
      if (!snapshotsMatch(snapshot, claimed)) {
        throw new Error("legacy APNs source changed before Doctor could claim it");
      }
      snapshot = claimed;
    } catch (error) {
      const restoreError = await restoreClaim({
        stateRoot: params.stateRoot,
        stateDir: params.stateDir,
        sourcePath,
      });
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
    const restoreError = await restoreClaim({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      sourcePath,
    });
    warnings.push(
      `Failed migrating legacy APNs state: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
    );
    return { changes, warnings };
  }

  try {
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, sourcePath))) {
      throw new Error("legacy APNs source reappeared during import");
    }
    await removePath({ ...params, sourcePath: claimPath });
    markSourceRemoved(result.sourceKey, params.env);
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
        `Failed migrating legacy APNs state: ${detail}. Stop the Gateway and run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: ["Failed migrating legacy APNs state: exclusive state ownership unavailable."],
    };
  }

  let result: MigrationMessages = { changes: [], warnings: [] };
  let releaseError: unknown;
  try {
    try {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        symlinks: "reject",
      });
      result = await migrateWithExclusiveStateOwnership({
        ...params,
        env,
        stateRoot,
      });
    } catch (error) {
      result.warnings.push(`Failed reading legacy APNs state: ${String(error)}`);
    }
  } finally {
    try {
      await lock.release();
    } catch (error) {
      releaseError = error;
    }
  }
  if (releaseError) {
    result.warnings.push(`APNs migration lock release failed: ${formatErrorMessage(releaseError)}`);
  }
  return result;
}

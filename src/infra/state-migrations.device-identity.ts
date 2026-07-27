// Doctor-only import for the retired primary device identity JSON.
import { createHash } from "node:crypto";
import path from "node:path";
import { root, type Root } from "@openclaw/fs-safe";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { acquireDeviceIdentityCoordinator } from "./device-identity-coordinator.js";
import {
  normalizeLegacyDeviceIdentity,
  type NormalizedLegacyDeviceIdentity,
} from "./device-identity-legacy.js";
import {
  resolveDeviceIdentityStore,
  validateStoredDeviceIdentity,
  type DeviceIdentity,
} from "./device-identity-store.js";
import { deriveEd25519PrivateKeyRaw, deriveEd25519PublicKeyRaw } from "./ed25519-signature.js";
import { formatErrorMessage } from "./errors.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  hasLegacyDeviceIdentityPath,
  repairInvalidCanonicalIdentity,
} from "./state-migrations.device-identity-repair.js";
import type { LegacyDeviceIdentityDetection } from "./state-migrations.device-identity.types.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const IDENTITY_KEY = "primary";
const MIGRATION_KIND = "legacy-device-identity-json";
const MIGRATION_LOCK_TIMEOUT_MS = 250;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 25;
const MAX_LEGACY_IDENTITY_BYTES = 128 * 1024;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isValidCreatedAtMs(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function deviceIdentityKeyMaterialMatches(left: DeviceIdentity, right: DeviceIdentity): boolean {
  try {
    return (
      deriveEd25519PublicKeyRaw(left.publicKeyPem).equals(
        deriveEd25519PublicKeyRaw(right.publicKeyPem),
      ) &&
      deriveEd25519PrivateKeyRaw(left.privateKeyPem).equals(
        deriveEd25519PrivateKeyRaw(right.privateKeyPem),
      )
    );
  } catch {
    return false;
  }
}

type DeviceIdentityMigrationDatabase = Pick<
  OpenClawStateKyselyDatabase,
  "device_identities" | "migration_runs" | "migration_sources"
>;

type LegacySourceSnapshot = {
  sourcePath: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  sha256: string;
  size: number;
  identity: NormalizedLegacyDeviceIdentity;
};

type MigrationReceipt = {
  sourceKey: string;
  sourceSha256: string | null;
  removedSource: boolean;
};

export { detectLegacyDeviceIdentity } from "./state-migrations.device-identity-repair.js";

function relativeLegacyPath(stateDir: string, filePath: string): string {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(filePath));
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error("legacy device identity path is outside the state directory");
  }
  return relativePath;
}

async function readLegacySourceSnapshot(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
}): Promise<LegacySourceSnapshot> {
  const opened = await params.stateRoot.read(
    relativeLegacyPath(params.stateDir, params.sourcePath),
    {
      hardlinks: "reject",
      maxBytes: MAX_LEGACY_IDENTITY_BYTES,
      symlinks: "reject",
    },
  );
  if (opened.stat.size !== opened.buffer.byteLength) {
    throw new Error("legacy device identity changed while it was being read");
  }
  const identity = normalizeLegacyDeviceIdentity(JSON.parse(utf8Decoder.decode(opened.buffer)));
  if (!identity) {
    throw new Error("legacy device identity is invalid or unsupported");
  }
  return {
    sourcePath: params.sourcePath,
    dev: opened.stat.dev,
    ino: opened.stat.ino,
    mtimeMs: opened.stat.mtimeMs,
    sha256: createHash("sha256").update(opened.buffer).digest("hex"),
    size: opened.stat.size,
    identity,
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
  return `device-identity-json:${createHash("sha256").update(path.resolve(sourcePath)).digest("hex")}`;
}

function readMigrationReceipt(sourcePath: string, env: NodeJS.ProcessEnv): MigrationReceipt | null {
  const sourceKey = receiptSourceKey(sourcePath);
  const { db } = openOpenClawStateDatabase({ env });
  const row = executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DeviceIdentityMigrationDatabase>(db)
      .selectFrom("migration_sources")
      .select(["removed_source", "source_sha256"])
      .where("source_key", "=", sourceKey),
  );
  return row
    ? {
        sourceKey,
        sourceSha256: row.source_sha256,
        removedSource: row.removed_source === 1,
      }
    : null;
}

type CanonicalIdentityRow = {
  identity_key: string;
  device_id: string;
  public_key_pem: string;
  private_key_pem: string;
  created_at_ms: number;
  updated_at_ms: number;
};

function classifyCanonicalRow(
  row: CanonicalIdentityRow,
  identity: NormalizedLegacyDeviceIdentity,
): "same" | "different" | "invalid" {
  if (!isValidCreatedAtMs(row.updated_at_ms)) {
    return "invalid";
  }
  try {
    validateStoredDeviceIdentity(
      {
        deviceId: row.device_id,
        publicKeyPem: row.public_key_pem,
        privateKeyPem: row.private_key_pem,
        createdAtMs: row.created_at_ms,
      },
      row.identity_key,
    );
  } catch {
    return "invalid";
  }
  // Valid identities are equal by key fingerprint. PEM text and timestamps are
  // serialization metadata, not a reason to rotate an already-canonical key.
  return row.identity_key === IDENTITY_KEY &&
    row.device_id === identity.deviceId &&
    deviceIdentityKeyMaterialMatches(
      {
        deviceId: row.device_id,
        publicKeyPem: row.public_key_pem,
        privateKeyPem: row.private_key_pem,
      },
      identity,
    )
    ? "same"
    : "different";
}

function readCanonicalIdentity(
  db: ReturnType<typeof openOpenClawStateDatabase>["db"],
): CanonicalIdentityRow | undefined {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<DeviceIdentityMigrationDatabase>(db)
      .selectFrom("device_identities")
      .selectAll()
      .where("identity_key", "=", IDENTITY_KEY),
  );
}

function verifyCanonicalIdentity(
  identity: NormalizedLegacyDeviceIdentity,
  env: NodeJS.ProcessEnv,
): void {
  const { db } = openOpenClawStateDatabase({ env });
  const row = readCanonicalIdentity(db);
  if (!row || classifyCanonicalRow(row, identity) !== "same") {
    throw new Error("canonical SQLite device identity no longer matches the legacy source");
  }
}

function importAndRecordReceipt(params: {
  env: NodeJS.ProcessEnv;
  sourcePath: string;
  snapshot: LegacySourceSnapshot;
}): { sourceKey: string; imported: boolean } {
  const sourceKey = receiptSourceKey(params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<DeviceIdentityMigrationDatabase>(db);
      const existingReceipt = executeSqliteQueryTakeFirstSync(
        db,
        stateDb
          .selectFrom("migration_sources")
          .select("source_sha256")
          .where("source_key", "=", sourceKey),
      );
      if (existingReceipt) {
        if (existingReceipt.source_sha256 !== params.snapshot.sha256) {
          throw new Error("migration receipt belongs to different device identity bytes");
        }
        const existing = readCanonicalIdentity(db);
        if (!existing || classifyCanonicalRow(existing, params.snapshot.identity) !== "same") {
          throw new Error("migration receipt does not match the canonical device identity");
        }
        return { sourceKey, imported: false };
      }

      const existing = readCanonicalIdentity(db);
      const existingState = existing
        ? classifyCanonicalRow(existing, params.snapshot.identity)
        : undefined;
      if (existingState === "different") {
        throw new Error("canonical SQLite device identity differs from the legacy identity");
      }
      const imported = !existing || existingState === "invalid";
      const repaired = existingState === "invalid";
      if (!existing) {
        executeSqliteQuerySync(
          db,
          stateDb.insertInto("device_identities").values({
            identity_key: IDENTITY_KEY,
            device_id: params.snapshot.identity.deviceId,
            public_key_pem: params.snapshot.identity.publicKeyPem,
            private_key_pem: params.snapshot.identity.privateKeyPem,
            created_at_ms: params.snapshot.identity.createdAtMs,
            updated_at_ms: now,
          }),
        );
      } else if (repaired) {
        executeSqliteQuerySync(
          db,
          stateDb
            .updateTable("device_identities")
            .set({
              device_id: params.snapshot.identity.deviceId,
              public_key_pem: params.snapshot.identity.publicKeyPem,
              private_key_pem: params.snapshot.identity.privateKeyPem,
              created_at_ms: params.snapshot.identity.createdAtMs,
              updated_at_ms: now,
            })
            .where("identity_key", "=", IDENTITY_KEY),
        );
      }

      const verified = readCanonicalIdentity(db);
      if (!verified || classifyCanonicalRow(verified, params.snapshot.identity) !== "same") {
        throw new Error("SQLite verification failed for the primary device identity");
      }

      const reportJson = JSON.stringify({
        source: MIGRATION_KIND,
        target: "device_identities",
        identityKey: IDENTITY_KEY,
        deviceId: params.snapshot.identity.deviceId,
        sourceSha256: params.snapshot.sha256,
        importedRecordCount: imported ? 1 : 0,
        preservedSqliteRecordCount: existing ? 1 : 0,
        repairedSqliteRecordCount: repaired ? 1 : 0,
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
          target_table: "device_identities",
          source_sha256: params.snapshot.sha256,
          source_size_bytes: params.snapshot.size,
          source_record_count: 1,
          last_run_id: runId,
          status: "completed",
          imported_at: now,
          removed_source: 0,
          report_json: reportJson,
        }),
      );
      return { sourceKey, imported };
    },
    { env: params.env },
  );
}

function markSourceRemoved(sourceKey: string, env: NodeJS.ProcessEnv): void {
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      executeSqliteQuerySync(
        db,
        getNodeSqliteKysely<DeviceIdentityMigrationDatabase>(db)
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

async function restoreClaim(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
  claimPath: string;
}): Promise<string | null> {
  try {
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, params.claimPath)))) {
      return null;
    }
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, params.sourcePath))) {
      return `source path already exists: ${params.sourcePath}`;
    }
    await params.stateRoot.move(
      relativeLegacyPath(params.stateDir, params.claimPath),
      relativeLegacyPath(params.stateDir, params.sourcePath),
    );
    return null;
  } catch (error) {
    return String(error);
  }
}

async function cleanupReceiptSources(params: {
  stateRoot: Root;
  stateDir: string;
  detected: LegacyDeviceIdentityDetection;
  receipt: MigrationReceipt;
  env: NodeJS.ProcessEnv;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (
    await params.stateRoot.exists(
      relativeLegacyPath(params.stateDir, params.detected.nativeClaimPath),
    )
  ) {
    return {
      changes: [],
      warnings: [
        "Native device identity import is pending; restart the native app before running Doctor cleanup.",
      ],
    };
  }
  const changes: string[] = [];
  const warnings: string[] = [];
  let removed = 0;
  for (const candidate of [params.detected.sourcePath, params.detected.claimPath]) {
    if (!(await params.stateRoot.exists(relativeLegacyPath(params.stateDir, candidate)))) {
      continue;
    }
    let snapshot: LegacySourceSnapshot;
    try {
      snapshot = await readLegacySourceSnapshot({
        stateRoot: params.stateRoot,
        stateDir: params.stateDir,
        sourcePath: candidate,
      });
    } catch (error) {
      warnings.push(`Retired device identity cleanup refused ${candidate}: ${String(error)}`);
      continue;
    }
    if (snapshot.sha256 !== params.receipt.sourceSha256) {
      warnings.push(
        `Retired device identity cleanup preserved ${candidate}: bytes differ from the migration receipt.`,
      );
      continue;
    }
    try {
      verifyCanonicalIdentity(snapshot.identity, params.env);
      await removePath({ ...params, sourcePath: candidate });
      removed += 1;
    } catch (error) {
      warnings.push(`Retired device identity cleanup failed for ${candidate}: ${String(error)}`);
    }
  }
  if (warnings.length === 0 && (!params.receipt.removedSource || removed > 0)) {
    markSourceRemoved(params.receipt.sourceKey, params.env);
  }
  if (removed > 0) {
    changes.push("Removed retired device identity JSON covered by its SQLite receipt.");
  }
  return { changes, warnings };
}

async function migrateWithExclusiveStateOwnership(params: {
  detected: LegacyDeviceIdentityDetection;
  stateRoot: Root;
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: (sourcePath: string) => void;
  beforeCleanup?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const receipt = readMigrationReceipt(params.detected.sourcePath, params.env);
  if (receipt) {
    return await cleanupReceiptSources({ ...params, receipt });
  }

  if (
    await params.stateRoot.exists(
      relativeLegacyPath(params.stateDir, params.detected.nativeClaimPath),
    )
  ) {
    return {
      changes: [],
      warnings: [
        "Native device identity import is pending; restart the native app before running Doctor.",
      ],
    };
  }

  const hasSource = await params.stateRoot.exists(
    relativeLegacyPath(params.stateDir, params.detected.sourcePath),
  );
  const hasClaim = await params.stateRoot.exists(
    relativeLegacyPath(params.stateDir, params.detected.claimPath),
  );
  if (hasSource && hasClaim) {
    return {
      changes: [],
      warnings: [
        "Failed migrating legacy device identity: source and interrupted claim both exist.",
      ],
    };
  }
  const activePath = hasSource
    ? params.detected.sourcePath
    : hasClaim
      ? params.detected.claimPath
      : null;
  if (!activePath) {
    return { changes: [], warnings: [] };
  }

  let snapshot: LegacySourceSnapshot;
  try {
    snapshot = await readLegacySourceSnapshot({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      sourcePath: activePath,
    });
  } catch (error) {
    return {
      changes: [],
      warnings: [`Failed reading legacy device identity: ${String(error)}`],
    };
  }

  if (activePath === params.detected.sourcePath) {
    try {
      params.beforeClaim?.(params.detected.sourcePath);
      await params.stateRoot.move(
        relativeLegacyPath(params.stateDir, params.detected.sourcePath),
        relativeLegacyPath(params.stateDir, params.detected.claimPath),
      );
      const claimed = await readLegacySourceSnapshot({
        stateRoot: params.stateRoot,
        stateDir: params.stateDir,
        sourcePath: params.detected.claimPath,
      });
      if (!snapshotsMatch(snapshot, claimed)) {
        throw new Error("legacy device identity changed before Doctor could claim it");
      }
      snapshot = claimed;
    } catch (error) {
      const restoreError = await restoreClaim({ ...params, ...params.detected });
      return {
        changes: [],
        warnings: [
          `Failed migrating legacy device identity: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
        ],
      };
    }
  }

  let result: ReturnType<typeof importAndRecordReceipt>;
  try {
    result = importAndRecordReceipt({
      env: params.env,
      sourcePath: params.detected.sourcePath,
      snapshot,
    });
  } catch (error) {
    const restoreError = await restoreClaim({ ...params, ...params.detected });
    return {
      changes: [],
      warnings: [
        `Failed migrating legacy device identity: ${String(error)}${restoreError ? `; restore failure: ${restoreError}` : ""}`,
      ],
    };
  }

  try {
    params.beforeCleanup?.();
    if (
      await params.stateRoot.exists(relativeLegacyPath(params.stateDir, params.detected.sourcePath))
    ) {
      throw new Error("legacy device identity source reappeared during import");
    }
    const finalSnapshot = await readLegacySourceSnapshot({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      sourcePath: params.detected.claimPath,
    });
    if (!snapshotsMatch(snapshot, finalSnapshot)) {
      throw new Error("legacy device identity claim changed after SQLite import");
    }
    verifyCanonicalIdentity(finalSnapshot.identity, params.env);
    await removePath({ ...params, sourcePath: params.detected.claimPath });
    if (
      await params.stateRoot.exists(relativeLegacyPath(params.stateDir, params.detected.claimPath))
    ) {
      throw new Error("legacy device identity Doctor claim remains after cleanup");
    }
    markSourceRemoved(result.sourceKey, params.env);
  } catch (error) {
    return {
      changes: [],
      warnings: [`Device identity is in SQLite, but legacy cleanup failed: ${String(error)}`],
    };
  }

  return {
    changes: [
      result.imported
        ? "Migrated primary device identity to SQLite."
        : "Preserved identical primary device identity already in SQLite.",
    ],
    warnings: [],
    notices: ["Removed retired device identity JSON after verified SQLite import."],
  };
}

/** Import the retired primary identity while excluding Gateways that can recreate it. */
export async function migrateLegacyDeviceIdentity(params: {
  detected: LegacyDeviceIdentityDetection;
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  doctorOnlyStateMigrations?: boolean;
  beforeClaim?: (sourcePath: string) => void;
  beforeCleanup?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  if (!params.detected.hasLegacy && !params.detected.hasInvalidCanonical) {
    return { changes: [], warnings: [] };
  }
  if (params.doctorOnlyStateMigrations !== true) {
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
        `Failed migrating legacy device identity: ${detail}. Stop the Gateway and run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: ["Failed migrating legacy device identity: exclusive state ownership unavailable."],
    };
  }

  let result: MigrationMessages = { changes: [], warnings: [] };
  let releaseError: unknown;
  let identityCoordinator: ReturnType<typeof acquireDeviceIdentityCoordinator> | undefined;
  try {
    try {
      identityCoordinator = acquireDeviceIdentityCoordinator({
        databasePath: resolveDeviceIdentityStore({ env, identityKey: IDENTITY_KEY }).databasePath,
      });
    } catch (error) {
      result.warnings.push(
        `Failed migrating legacy device identity: identity state is busy (${formatErrorMessage(error)}).`,
      );
    }
    if (identityCoordinator) {
      try {
        const hasLegacyNow = hasLegacyDeviceIdentityPath(params.detected);
        if (hasLegacyNow) {
          const stateRoot = await root(params.stateDir, {
            hardlinks: "reject",
            maxBytes: MAX_LEGACY_IDENTITY_BYTES,
            symlinks: "reject",
          });
          result = await migrateWithExclusiveStateOwnership({ ...params, env, stateRoot });
        } else if (params.detected.hasInvalidCanonical) {
          result = repairInvalidCanonicalIdentity(env);
        }
      } catch (error) {
        result.warnings.push(`Failed reading legacy device identity state: ${String(error)}`);
      }
    }
  } finally {
    try {
      identityCoordinator?.release();
    } catch (error) {
      releaseError = error;
    }
    try {
      await lock.release();
    } catch (error) {
      releaseError ??= error;
    }
  }
  if (releaseError) {
    result.warnings.push(
      `Device identity migration lock release failed: ${formatErrorMessage(releaseError)}`,
    );
  }
  return result;
}

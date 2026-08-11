// Doctor-only import for the retired primary device identity JSON.
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
  legacyMigrationSourceSnapshotsMatch as snapshotsMatch,
  readLegacyMigrationSourceSnapshot,
  resolveLegacyMigrationRelativePath,
  type LegacyMigrationSourceSnapshot,
} from "./state-migrations.source-snapshot.js";
import type { MigrationMessages } from "./state-migrations.types.js";

const IDENTITY_KEY = "primary";
const MIGRATION_KIND = "legacy-device-identity-json";
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

type DeviceIdentityMigrationDatabase = Pick<OpenClawStateKyselyDatabase, "device_identities">;

type LegacySourceSnapshot = LegacyMigrationSourceSnapshot & {
  identity: NormalizedLegacyDeviceIdentity;
};

export { detectLegacyDeviceIdentity } from "./state-migrations.device-identity-repair.js";

function relativeLegacyPath(stateDir: string, filePath: string): string {
  return resolveLegacyMigrationRelativePath(stateDir, filePath, "device identity", false);
}

async function readLegacySourceSnapshot(params: {
  stateRoot: Root;
  stateDir: string;
  sourcePath: string;
}): Promise<LegacySourceSnapshot> {
  const snapshot = await readLegacyMigrationSourceSnapshot({
    ...params,
    maxBytes: MAX_LEGACY_IDENTITY_BYTES,
    label: "device identity",
  });
  const identity = normalizeLegacyDeviceIdentity(JSON.parse(utf8Decoder.decode(snapshot.buffer)));
  if (!identity) {
    throw new Error("legacy device identity is invalid or unsupported");
  }
  return { ...snapshot, identity };
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
  const sourceKey = resolveLegacyMigrationSourceKey("device-identity-json", params.sourcePath);
  const runId = `${sourceKey}:${params.snapshot.sha256.slice(0, 16)}`;
  const now = Date.now();
  return runOpenClawStateWriteTransaction(
    ({ db }) => {
      const stateDb = getNodeSqliteKysely<DeviceIdentityMigrationDatabase>(db);
      const existingReceipt = readLegacyMigrationReceiptFromDatabase(db, sourceKey);
      if (existingReceipt) {
        if (existingReceipt.sourceSha256 !== params.snapshot.sha256) {
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
      recordLegacyMigrationReceipt(db, {
        sourceKey,
        migrationKind: MIGRATION_KIND,
        sourcePath: params.sourcePath,
        targetTable: "device_identities",
        sourceSha256: params.snapshot.sha256,
        sourceSizeBytes: params.snapshot.size,
        sourceRecordCount: 1,
        runId,
        now,
        reportJson,
      });
      return { sourceKey, imported };
    },
    { env: params.env },
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
  receipt: LegacyMigrationReceipt;
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
    markLegacyMigrationSourceRemoved(params.receipt.sourceKey, params.env);
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
  const receipt = readLegacyMigrationReceipt(
    resolveLegacyMigrationSourceKey("device-identity-json", params.detected.sourcePath),
    params.env,
  );
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
    markLegacyMigrationSourceRemoved(result.sourceKey, params.env);
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
  let identityCoordinator: ReturnType<typeof acquireDeviceIdentityCoordinator> | undefined;
  return await withLegacyMigrationStateLock({
    stateDir: params.stateDir,
    env: params.env,
    label: "legacy device identity",
    releaseLabel: "Device identity",
    errorLabel: "Failed reading legacy device identity state",
    beforeRelease: () => identityCoordinator?.release(),
    run: async (env) => {
      try {
        identityCoordinator = acquireDeviceIdentityCoordinator({
          databasePath: resolveDeviceIdentityStore({ env, identityKey: IDENTITY_KEY }).databasePath,
          stateDir: params.stateDir,
        });
      } catch (error) {
        return {
          changes: [],
          warnings: [
            `Failed migrating legacy device identity: identity state is busy (${formatErrorMessage(error)}).`,
          ],
        };
      }
      if (hasLegacyDeviceIdentityPath(params.detected)) {
        const stateRoot = await root(params.stateDir, {
          hardlinks: "reject",
          maxBytes: MAX_LEGACY_IDENTITY_BYTES,
          symlinks: "reject",
        });
        return await migrateWithExclusiveStateOwnership({ ...params, env, stateRoot });
      }
      return params.detected.hasInvalidCanonical
        ? repairInvalidCanonicalIdentity(env)
        : { changes: [], warnings: [] };
    },
  });
}

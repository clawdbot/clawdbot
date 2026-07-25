import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { root, type Root } from "@openclaw/fs-safe";
import { runOpenClawStateWriteTransaction } from "../state/openclaw-state-db.js";
import { formatErrorMessage } from "./errors.js";
import { acquireGatewayLock, GatewayLockError } from "./gateway-lock.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  createWebPushVapidKeyPair,
  webPushSubscriptionFromRow,
  webPushSubscriptionToRow,
  webPushSubscriptionsEqual,
  webPushVapidKeyPairToRow,
  WEB_PUSH_VAPID_KEY_ID,
  type VapidKeyPair,
  type WebPushDatabase,
  type WebPushSubscription,
} from "./push-web-store.js";
import type { LegacyStateDetection, MigrationMessages } from "./state-migrations.types.js";
import {
  parseLegacySubscriptions,
  parseLegacyVapidKeys,
} from "./state-migrations.web-push-parse.js";

const LEGACY_SUBSCRIPTIONS_MAX_BYTES = 4 * 1024 * 1024;
const LEGACY_VAPID_KEYS_MAX_BYTES = 64 * 1024;
const MIGRATION_LOCK_TIMEOUT_MS = 250;
const MIGRATION_LOCK_POLL_INTERVAL_MS = 25;
const DOCTOR_CLAIM_SUFFIX = ".doctor-importing";

type LegacySourceSnapshot = {
  sourcePath: string;
  dev: number;
  ino: number;
  mtimeMs: number;
  raw: string;
  sha256: string;
  size: number;
};

type ParsedLegacyState = {
  subscriptions: Map<string, WebPushSubscription>;
  vapidKeys: VapidKeyPair | null;
  snapshots: LegacySourceSnapshot[];
};

function resolveLegacyWebPushPaths(stateDir: string) {
  return {
    subscriptionsPath: path.join(stateDir, "push", "web-push-subscriptions.json"),
    vapidKeysPath: path.join(stateDir, "push", "vapid-keys.json"),
  };
}

function legacyPathMayExist(filePath: string): boolean {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function relativeLegacyPath(stateDir: string, filePath: string): string {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(filePath));
  if (
    !relativePath ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  ) {
    throw new Error(`legacy Web Push path is outside the state directory: ${filePath}`);
  }
  return relativePath;
}

const sourceOrClaimMayExist = (sourcePath: string) =>
  legacyPathMayExist(sourcePath) || legacyPathMayExist(`${sourcePath}${DOCTOR_CLAIM_SUFFIX}`);

export function detectLegacyWebPush(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyStateDetection["webPush"] {
  const paths = resolveLegacyWebPushPaths(params.stateDir);
  return {
    ...paths,
    hasLegacy:
      params.doctorOnlyStateMigrations === true &&
      (sourceOrClaimMayExist(paths.subscriptionsPath) ||
        sourceOrClaimMayExist(paths.vapidKeysPath)),
  };
}

async function readLegacySourceSnapshot(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
  maxBytes: number,
): Promise<LegacySourceSnapshot> {
  const opened = await stateRoot.read(relativeLegacyPath(stateDir, sourcePath), {
    hardlinks: "reject",
    maxBytes,
    symlinks: "reject",
  });
  const raw = opened.buffer.toString("utf8");
  return {
    sourcePath,
    dev: opened.stat.dev,
    ino: opened.stat.ino,
    mtimeMs: opened.stat.mtimeMs,
    raw,
    sha256: createHash("sha256").update(raw).digest("hex"),
    size: opened.stat.size,
  };
}

function sourceSnapshotsMatch(left: LegacySourceSnapshot, right: LegacySourceSnapshot): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.sha256 === right.sha256 &&
    left.size === right.size
  );
}

function contentSnapshotsMatch(left: LegacySourceSnapshot, right: LegacySourceSnapshot): boolean {
  return left.sha256 === right.sha256 && left.size === right.size;
}

function maxBytesForSource(sourcePath: string, subscriptionsPath: string): number {
  return sourcePath === subscriptionsPath
    ? LEGACY_SUBSCRIPTIONS_MAX_BYTES
    : LEGACY_VAPID_KEYS_MAX_BYTES;
}

async function recoverInterruptedClaim(
  stateRoot: Root,
  stateDir: string,
  sourcePath: string,
  maxBytes: number,
): Promise<void> {
  const claimPath = `${sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
  const claimRelativePath = relativeLegacyPath(stateDir, claimPath);
  const sourceRelativePath = relativeLegacyPath(stateDir, sourcePath);
  if (!(await stateRoot.exists(claimRelativePath))) {
    return;
  }
  const claim = await readLegacySourceSnapshot(stateRoot, stateDir, claimPath, maxBytes);
  if (!(await stateRoot.exists(sourceRelativePath))) {
    await stateRoot.move(claimRelativePath, sourceRelativePath);
    return;
  }
  const source = await readLegacySourceSnapshot(stateRoot, stateDir, sourcePath, maxBytes);
  if (!contentSnapshotsMatch(claim, source)) {
    throw new Error("interrupted Web Push doctor claim conflicts with its source");
  }
  await stateRoot.remove(claimRelativePath);
}

async function readLegacyState(
  stateRoot: Root,
  stateDir: string,
  detected: LegacyStateDetection["webPush"],
  env: NodeJS.ProcessEnv,
): Promise<ParsedLegacyState> {
  await recoverInterruptedClaim(
    stateRoot,
    stateDir,
    detected.subscriptionsPath,
    LEGACY_SUBSCRIPTIONS_MAX_BYTES,
  );
  await recoverInterruptedClaim(
    stateRoot,
    stateDir,
    detected.vapidKeysPath,
    LEGACY_VAPID_KEYS_MAX_BYTES,
  );
  const snapshots: LegacySourceSnapshot[] = [];
  let subscriptions = new Map<string, WebPushSubscription>();
  let vapidKeys: VapidKeyPair | null = null;
  if (await stateRoot.exists(relativeLegacyPath(stateDir, detected.subscriptionsPath))) {
    const snapshot = await readLegacySourceSnapshot(
      stateRoot,
      stateDir,
      detected.subscriptionsPath,
      LEGACY_SUBSCRIPTIONS_MAX_BYTES,
    );
    subscriptions = parseLegacySubscriptions(snapshot.raw);
    snapshots.push(snapshot);
  }
  if (await stateRoot.exists(relativeLegacyPath(stateDir, detected.vapidKeysPath))) {
    const snapshot = await readLegacySourceSnapshot(
      stateRoot,
      stateDir,
      detected.vapidKeysPath,
      LEGACY_VAPID_KEYS_MAX_BYTES,
    );
    vapidKeys = parseLegacyVapidKeys(snapshot.raw, env);
    snapshots.push(snapshot);
  }
  return { subscriptions, vapidKeys, snapshots };
}

async function assertSourcesUnchanged(
  stateRoot: Root,
  stateDir: string,
  snapshots: readonly LegacySourceSnapshot[],
  subscriptionsPath: string,
): Promise<void> {
  for (const snapshot of snapshots) {
    const current = await readLegacySourceSnapshot(
      stateRoot,
      stateDir,
      snapshot.sourcePath,
      maxBytesForSource(snapshot.sourcePath, subscriptionsPath),
    );
    if (!sourceSnapshotsMatch(current, snapshot)) {
      throw new Error("legacy Web Push source changed after doctor loaded it");
    }
  }
}

function mergedSubscription(params: {
  existing: WebPushSubscription;
  legacy: WebPushSubscription;
}): WebPushSubscription {
  const { existing, legacy } = params;
  const createdAtMs = Math.min(existing.createdAtMs, legacy.createdAtMs);
  if (existing.updatedAtMs === legacy.updatedAtMs) {
    const normalizedExisting = { ...existing, createdAtMs };
    const normalizedLegacy = { ...legacy, createdAtMs };
    if (!webPushSubscriptionsEqual(normalizedExisting, normalizedLegacy)) {
      throw new Error("Web Push subscription diverges at the same timestamp");
    }
    return normalizedExisting;
  }
  const winner = existing.updatedAtMs > legacy.updatedAtMs ? existing : legacy;
  return { ...winner, createdAtMs };
}

function findSubscriptionById(db: DatabaseSync, subscriptionId: string) {
  return executeSqliteQueryTakeFirstSync(
    db,
    getNodeSqliteKysely<WebPushDatabase>(db)
      .selectFrom("web_push_subscriptions")
      .selectAll()
      .where("subscription_id", "=", subscriptionId),
  );
}

function writeSubscription(
  db: DatabaseSync,
  endpointHash: string,
  subscription: WebPushSubscription,
): void {
  const row = webPushSubscriptionToRow({ endpointHash, subscription });
  executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<WebPushDatabase>(db)
      .insertInto("web_push_subscriptions")
      .values(row)
      .onConflict((conflict) =>
        conflict.column("endpoint_hash").doUpdateSet({
          subscription_id: row.subscription_id,
          endpoint: row.endpoint,
          p256dh: row.p256dh,
          auth: row.auth,
          created_at_ms: row.created_at_ms,
          updated_at_ms: row.updated_at_ms,
        }),
      ),
  );
}

function migrateIntoDatabase(params: {
  stateDir: string;
  legacy: ParsedLegacyState;
  nowMs: number;
}): { importedSubscriptions: number; importedVapidKeys: boolean } {
  let importedSubscriptions = 0;
  let importedVapidKeys = false;
  runOpenClawStateWriteTransaction(
    ({ db }) => {
      const webPushDb = getNodeSqliteKysely<WebPushDatabase>(db);
      const expectedSubscriptions = new Map<string, WebPushSubscription>();
      for (const [endpointHash, legacySubscription] of params.legacy.subscriptions) {
        const existingRow = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("web_push_subscriptions")
            .selectAll()
            .where("endpoint_hash", "=", endpointHash),
        );
        if (existingRow && existingRow.endpoint !== legacySubscription.endpoint) {
          throw new Error("Web Push endpoint hash collision during legacy import");
        }
        const existing = existingRow ? webPushSubscriptionFromRow(existingRow) : null;
        const expected = existing
          ? mergedSubscription({ existing, legacy: legacySubscription })
          : legacySubscription;
        const conflictingIdRow = findSubscriptionById(db, expected.subscriptionId);
        if (conflictingIdRow && conflictingIdRow.endpoint_hash !== endpointHash) {
          throw new Error("Web Push subscription id conflicts with another endpoint");
        }
        if (!existing || !webPushSubscriptionsEqual(existing, expected)) {
          writeSubscription(db, endpointHash, expected);
          importedSubscriptions += 1;
        }
        expectedSubscriptions.set(endpointHash, expected);
      }

      let expectedVapidKeys: VapidKeyPair | null = null;
      if (params.legacy.vapidKeys) {
        const existingVapidRow = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("web_push_vapid_keys")
            .selectAll()
            .where("key_id", "=", WEB_PUSH_VAPID_KEY_ID),
        );
        if (existingVapidRow) {
          if (
            existingVapidRow.public_key !== params.legacy.vapidKeys.publicKey ||
            existingVapidRow.private_key !== params.legacy.vapidKeys.privateKey
          ) {
            throw new Error("legacy Web Push VAPID identity conflicts with SQLite");
          }
          expectedVapidKeys = createWebPushVapidKeyPair(
            existingVapidRow.public_key,
            existingVapidRow.private_key,
            existingVapidRow.subject,
          );
        } else {
          executeSqliteQuerySync(
            db,
            webPushDb
              .insertInto("web_push_vapid_keys")
              .values(
                webPushVapidKeyPairToRow({ keyPair: params.legacy.vapidKeys, nowMs: params.nowMs }),
              ),
          );
          expectedVapidKeys = params.legacy.vapidKeys;
          importedVapidKeys = true;
        }
      }

      for (const [endpointHash, expected] of expectedSubscriptions) {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("web_push_subscriptions")
            .selectAll()
            .where("endpoint_hash", "=", endpointHash),
        );
        if (!row || !webPushSubscriptionsEqual(webPushSubscriptionFromRow(row), expected)) {
          throw new Error("SQLite verification failed for a Web Push subscription");
        }
      }
      if (expectedVapidKeys) {
        const row = executeSqliteQueryTakeFirstSync(
          db,
          webPushDb
            .selectFrom("web_push_vapid_keys")
            .selectAll()
            .where("key_id", "=", WEB_PUSH_VAPID_KEY_ID),
        );
        if (
          !row ||
          row.public_key !== expectedVapidKeys.publicKey ||
          row.private_key !== expectedVapidKeys.privateKey ||
          row.subject !== expectedVapidKeys.subject
        ) {
          throw new Error("SQLite verification failed for the Web Push VAPID identity");
        }
      }
    },
    { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } },
  );
  return { importedSubscriptions, importedVapidKeys };
}

async function restoreClaims(params: {
  stateRoot: Root;
  stateDir: string;
  claimed: readonly LegacySourceSnapshot[];
}): Promise<string[]> {
  const errors: string[] = [];
  for (const snapshot of params.claimed.toReversed()) {
    const claimPath = `${snapshot.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
    const claimRelativePath = relativeLegacyPath(params.stateDir, claimPath);
    const sourceRelativePath = relativeLegacyPath(params.stateDir, snapshot.sourcePath);
    try {
      if (!(await params.stateRoot.exists(claimRelativePath))) {
        continue;
      }
      if (await params.stateRoot.exists(sourceRelativePath)) {
        errors.push(`source path already exists: ${snapshot.sourcePath}`);
        continue;
      }
      await params.stateRoot.move(claimRelativePath, sourceRelativePath);
    } catch (error) {
      errors.push(String(error));
    }
  }
  return errors;
}

async function claimLegacySources(params: {
  stateRoot: Root;
  stateDir: string;
  snapshots: readonly LegacySourceSnapshot[];
  subscriptionsPath: string;
  beforeClaim?: () => void;
}): Promise<LegacySourceSnapshot[]> {
  params.beforeClaim?.();
  const claimed: LegacySourceSnapshot[] = [];
  try {
    for (const snapshot of params.snapshots) {
      const claimPath = `${snapshot.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
      await params.stateRoot.move(
        relativeLegacyPath(params.stateDir, snapshot.sourcePath),
        relativeLegacyPath(params.stateDir, claimPath),
      );
      claimed.push(snapshot);
      const current = await readLegacySourceSnapshot(
        params.stateRoot,
        params.stateDir,
        claimPath,
        maxBytesForSource(snapshot.sourcePath, params.subscriptionsPath),
      );
      if (!sourceSnapshotsMatch(current, snapshot)) {
        throw new Error("legacy Web Push source changed before doctor could claim it");
      }
    }
  } catch (error) {
    const restoreErrors = await restoreClaims({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      claimed,
    });
    throw new Error(
      `${String(error)}${restoreErrors.length > 0 ? `; restore failures: ${restoreErrors.join("; ")}` : ""}`,
      { cause: error },
    );
  }

  return claimed;
}

async function removeClaimedSources(params: {
  stateRoot: Root;
  stateDir: string;
  claimed: readonly LegacySourceSnapshot[];
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<void> {
  for (const snapshot of params.claimed) {
    if (await params.stateRoot.exists(relativeLegacyPath(params.stateDir, snapshot.sourcePath))) {
      throw new Error(`legacy Web Push source reappeared during import: ${snapshot.sourcePath}`);
    }
  }
  for (const snapshot of params.claimed) {
    const claimPath = `${snapshot.sourcePath}${DOCTOR_CLAIM_SUFFIX}`;
    if (params.removeSource) {
      await params.removeSource(claimPath);
    } else {
      await params.stateRoot.remove(relativeLegacyPath(params.stateDir, claimPath));
    }
  }
}

async function migrateLegacyWebPushWithExclusiveStateOwnership(params: {
  stateRoot: Root;
  detected: LegacyStateDetection["webPush"];
  stateDir: string;
  env: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
  removeSource?: (sourcePath: string) => Promise<void> | void;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const notices: string[] = [];
  if (!params.detected.hasLegacy) {
    return { changes, warnings };
  }

  let legacy: ParsedLegacyState;
  try {
    legacy = await readLegacyState(params.stateRoot, params.stateDir, params.detected, params.env);
  } catch (error) {
    warnings.push(`Failed reading legacy Web Push state: ${String(error)}`);
    return { changes, warnings };
  }

  let claimed: LegacySourceSnapshot[];
  try {
    params.beforeVerify?.();
    await assertSourcesUnchanged(
      params.stateRoot,
      params.stateDir,
      legacy.snapshots,
      params.detected.subscriptionsPath,
    );
    // Claim both sources before the database transaction. A legacy writer can no longer
    // overwrite the retired paths after SQLite becomes canonical.
    claimed = await claimLegacySources({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      snapshots: legacy.snapshots,
      subscriptionsPath: params.detected.subscriptionsPath,
      beforeClaim: params.beforeClaim,
    });
  } catch (error) {
    warnings.push(`Failed migrating legacy Web Push state: ${String(error)}`);
    return { changes, warnings };
  }

  let result: { importedSubscriptions: number; importedVapidKeys: boolean };
  try {
    result = migrateIntoDatabase({
      stateDir: params.stateDir,
      legacy,
      nowMs: Date.now(),
    });
  } catch (error) {
    const restoreErrors = await restoreClaims({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      claimed,
    });
    warnings.push(
      `Failed migrating legacy Web Push state: ${String(error)}${
        restoreErrors.length > 0 ? `; restore failures: ${restoreErrors.join("; ")}` : ""
      }`,
    );
    return { changes, warnings };
  }

  try {
    await removeClaimedSources({
      stateRoot: params.stateRoot,
      stateDir: params.stateDir,
      claimed,
      removeSource: params.removeSource,
    });
  } catch (error) {
    warnings.push(`Web Push state is in SQLite, but legacy cleanup failed: ${String(error)}`);
    return { changes, warnings };
  }

  changes.push(
    `Migrated ${result.importedSubscriptions} Web Push subscription${result.importedSubscriptions === 1 ? "" : "s"} to SQLite.`,
  );
  if (result.importedVapidKeys) {
    changes.push("Migrated the Web Push VAPID identity to SQLite.");
  }
  notices.push("Removed retired Web Push JSON state after verified SQLite import.");
  return { changes, warnings, notices };
}

export async function migrateLegacyWebPush(params: {
  detected: LegacyStateDetection["webPush"];
  stateDir: string;
  env?: NodeJS.ProcessEnv;
  beforeClaim?: () => void;
  beforeVerify?: () => void;
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
        `Failed migrating legacy Web Push state: ${detail}. Stop the Gateway and run \`openclaw doctor --fix\` again.`,
      ],
    };
  }
  if (!lock) {
    return {
      changes: [],
      warnings: ["Failed migrating legacy Web Push state: exclusive state ownership unavailable."],
    };
  }

  let result: MigrationMessages = { changes: [], warnings: [] };
  let releaseError: unknown;
  try {
    try {
      const stateRoot = await root(params.stateDir, {
        hardlinks: "reject",
        maxBytes: LEGACY_SUBSCRIPTIONS_MAX_BYTES,
        symlinks: "reject",
      });
      result = await migrateLegacyWebPushWithExclusiveStateOwnership({
        ...params,
        env,
        stateRoot,
      });
    } catch (error) {
      result.warnings.push(`Failed reading legacy Web Push state: ${String(error)}`);
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
      `Web Push migration lock release failed: ${formatErrorMessage(releaseError)}`,
    );
  }
  return result;
}

// Canonical shared-SQLite store for Web Push subscriptions and VAPID identity.
import type { DatabaseSync } from "node:sqlite";
import type { Insertable, Selectable } from "kysely";
import type { WebPushDevicePreferences } from "../../packages/gateway-protocol/src/schema/push.js";
import { readConfigMachineState, updateConfigMachineState } from "../state/config-machine-state.js";
import { ensureColumn } from "../state/openclaw-state-db-schema-helpers.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
  type OpenClawStateDatabaseOptions,
} from "../state/openclaw-state-db.js";
import { sha256HexPrefixCore } from "./crypto-digest.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import { normalizeWebPushDevicePreferences } from "./push-web-preferences.js";

export const WEB_PUSH_VAPID_STATE_KEY = "webPush.vapidKeys";
export const DEFAULT_WEB_PUSH_VAPID_SUBJECT = "https://openclaw.ai";
const WEB_PUSH_MAX_ENDPOINT_LENGTH = 2048;
const WEB_PUSH_MAX_KEY_LENGTH = 512;
const WEB_PUSH_APPROVAL_RECOVERY_MAX_APPROVALS = 1_024;

export type WebPushSubscription = {
  subscriptionId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAtMs: number;
  updatedAtMs: number;
};

export type BoundWebPushSubscription = WebPushSubscription & {
  deviceId: string;
  userProfileId: string | null;
  devicePreferences: WebPushDevicePreferences;
};

export type VapidKeyPair = {
  publicKey: string;
  privateKey: string;
  subject: string;
};

export function createWebPushVapidKeyPair(
  publicKey: string,
  privateKey: string,
  subject: string,
): VapidKeyPair {
  return { publicKey, privateKey, subject };
}

export type WebPushDatabase = Pick<
  OpenClawStateKyselyDatabase,
  | "config_machine_state"
  | "operator_approvals"
  | "web_push_approval_deliveries"
  | "web_push_subscriptions"
>;
type WebPushSubscriptionRow = Selectable<WebPushDatabase["web_push_subscriptions"]>;
type WebPushSubscriptionInsert = Insertable<WebPushDatabase["web_push_subscriptions"]>;

const ensuredWebPushBindingDatabases = new WeakSet<DatabaseSync>();
const ensuredWebPushApprovalDeliveryDatabases = new WeakSet<DatabaseSync>();

const WEB_PUSH_APPROVAL_DELIVERY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS web_push_approval_deliveries (
  approval_id TEXT NOT NULL
    REFERENCES operator_approvals(approval_id) ON DELETE CASCADE,
  subscription_id TEXT NOT NULL
    REFERENCES web_push_subscriptions(subscription_id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  user_profile_id TEXT,
  prepared_at_ms INTEGER NOT NULL,
  PRIMARY KEY (approval_id, subscription_id)
) STRICT;

CREATE INDEX IF NOT EXISTS idx_web_push_approval_deliveries_subscription
  ON web_push_approval_deliveries(subscription_id, approval_id);
`;

function webPushStateDatabaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }
    : { env: process.env };
}

/** Adds downgrade-safe binding columns before the first Web Push store operation. */
export function ensureWebPushSubscriptionBindingColumns(db: DatabaseSync): void {
  ensureColumn(db, "web_push_subscriptions", "device_id TEXT");
  ensureColumn(db, "web_push_subscriptions", "user_profile_id TEXT");
  ensureColumn(db, "web_push_subscriptions", "preferences_json TEXT");
}

function ensureWebPushSubscriptionBindingSchema(stateDir?: string): void {
  const options = webPushStateDatabaseOptions(stateDir);
  const database = openOpenClawStateDatabase(options);
  if (ensuredWebPushBindingDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(
    ({ db }) => ensureWebPushSubscriptionBindingColumns(db),
    options,
    { operationLabel: "web-push.subscription-binding.schema.ensure" },
  );
  ensuredWebPushBindingDatabases.add(database.db);
}

/** Lazily adds the restart-safe approval delivery table on first feature use. */
function ensureWebPushApprovalDeliveryTable(db: DatabaseSync): void {
  // sqlite-allow-raw -- feature-local additive schema DDL; rows use Kysely.
  db.exec(WEB_PUSH_APPROVAL_DELIVERY_SCHEMA_SQL);
}

function ensureWebPushApprovalDeliverySchema(stateDir?: string): void {
  const options = webPushStateDatabaseOptions(stateDir);
  const database = openOpenClawStateDatabase(options);
  if (ensuredWebPushApprovalDeliveryDatabases.has(database.db)) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db }) => ensureWebPushApprovalDeliveryTable(db), options, {
    operationLabel: "web-push.approval-delivery.schema.ensure",
  });
  ensuredWebPushApprovalDeliveryDatabases.add(database.db);
}

export function hashWebPushEndpoint(endpoint: string): string {
  return sha256HexPrefixCore(endpoint, 32);
}

export function isValidWebPushEndpoint(endpoint: string): boolean {
  if (!endpoint || endpoint.length > WEB_PUSH_MAX_ENDPOINT_LENGTH) {
    return false;
  }
  try {
    return new URL(endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

export function isValidWebPushKey(key: unknown): key is string {
  return typeof key === "string" && key.length > 0 && key.length <= WEB_PUSH_MAX_KEY_LENGTH;
}

export function webPushSubscriptionFromRow(row: WebPushSubscriptionRow): WebPushSubscription {
  return {
    subscriptionId: row.subscription_id,
    endpoint: row.endpoint,
    keys: { p256dh: row.p256dh, auth: row.auth },
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function boundWebPushSubscriptionFromRow(
  row: WebPushSubscriptionRow,
): BoundWebPushSubscription | null {
  if (!row.device_id) {
    return null;
  }
  return {
    ...webPushSubscriptionFromRow(row),
    deviceId: row.device_id,
    userProfileId: row.user_profile_id,
    devicePreferences: normalizeWebPushDevicePreferences(
      parseDevicePreferences(row.preferences_json),
    ),
  };
}

function parseDevicePreferences(value: string | null): unknown {
  if (!value) {
    return undefined;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

export function webPushSubscriptionToRow(params: {
  endpointHash: string;
  subscription: WebPushSubscription;
  binding?: { deviceId: string; userProfileId: string | null };
}): WebPushSubscriptionInsert {
  return {
    endpoint_hash: params.endpointHash,
    subscription_id: params.subscription.subscriptionId,
    endpoint: params.subscription.endpoint,
    p256dh: params.subscription.keys.p256dh,
    auth: params.subscription.keys.auth,
    device_id: params.binding?.deviceId ?? null,
    user_profile_id: params.binding?.userProfileId ?? null,
    preferences_json: null,
    created_at_ms: params.subscription.createdAtMs,
    updated_at_ms: params.subscription.updatedAtMs,
  };
}

export function findBoundWebPushSubscriptionByEndpoint(params: {
  endpoint: string;
  stateDir?: string;
}): BoundWebPushSubscription | null {
  ensureWebPushSubscriptionBindingSchema(params.stateDir);
  const database = openOpenClawStateDatabase(webPushStateDatabaseOptions(params.stateDir));
  const row = executeSqliteQueryTakeFirstSync(
    database.db,
    getNodeSqliteKysely<WebPushDatabase>(database.db)
      .selectFrom("web_push_subscriptions")
      .selectAll()
      .where("endpoint_hash", "=", hashWebPushEndpoint(params.endpoint))
      .where("endpoint", "=", params.endpoint),
  );
  return row ? boundWebPushSubscriptionFromRow(row) : null;
}

export function setWebPushSubscriptionPreferences(params: {
  endpoint: string;
  preferences: WebPushDevicePreferences;
  expectedDeviceId: string;
  expectedUserProfileId: string | null;
  stateDir?: string;
}): boolean {
  ensureWebPushSubscriptionBindingSchema(params.stateDir);
  const options = webPushStateDatabaseOptions(params.stateDir);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WebPushDatabase>(db)
        .updateTable("web_push_subscriptions")
        .set({
          preferences_json: JSON.stringify(normalizeWebPushDevicePreferences(params.preferences)),
          updated_at_ms: Date.now(),
        })
        .where("endpoint_hash", "=", hashWebPushEndpoint(params.endpoint))
        .where("endpoint", "=", params.endpoint)
        .where("device_id", "=", params.expectedDeviceId)
        .where(
          "user_profile_id",
          params.expectedUserProfileId === null ? "is" : "=",
          params.expectedUserProfileId,
        ),
    );
    return Number(result.numAffectedRows ?? 0) === 1;
  }, options);
}

export function webPushSubscriptionsEqual(
  left: WebPushSubscription,
  right: WebPushSubscription,
): boolean {
  return (
    left.subscriptionId === right.subscriptionId &&
    left.endpoint === right.endpoint &&
    left.keys.p256dh === right.keys.p256dh &&
    left.keys.auth === right.keys.auth &&
    left.createdAtMs === right.createdAtMs &&
    left.updatedAtMs === right.updatedAtMs
  );
}

export function listWebPushSubscriptions(stateDir?: string): WebPushSubscription[] {
  ensureWebPushSubscriptionBindingSchema(stateDir);
  const database = openOpenClawStateDatabase(webPushStateDatabaseOptions(stateDir));
  const stateDb = getNodeSqliteKysely<WebPushDatabase>(database.db);
  return executeSqliteQuerySync(
    database.db,
    stateDb
      .selectFrom("web_push_subscriptions")
      .selectAll()
      .orderBy("created_at_ms", "asc")
      .orderBy("subscription_id", "asc"),
  ).rows.map(webPushSubscriptionFromRow);
}

/** Lists only subscriptions reconciled by an authenticated browser device. */
export function listBoundWebPushSubscriptions(stateDir?: string): BoundWebPushSubscription[] {
  ensureWebPushSubscriptionBindingSchema(stateDir);
  const database = openOpenClawStateDatabase(webPushStateDatabaseOptions(stateDir));
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<WebPushDatabase>(database.db)
      .selectFrom("web_push_subscriptions")
      .selectAll()
      .where("device_id", "is not", null)
      .orderBy("created_at_ms", "asc")
      .orderBy("subscription_id", "asc"),
  ).rows;
  return rows.flatMap((row) => {
    const subscription = boundWebPushSubscriptionFromRow(row);
    return subscription ? [subscription] : [];
  });
}

/**
 * Record the subscriptions that may receive the request before network I/O.
 * Definite failures are removed after send; retaining the crash-ambiguous set
 * lets restart recovery replace any actionable notification that may exist.
 */
export function prepareWebPushApprovalDeliveries(params: {
  approvalId: string;
  subscriptions: readonly BoundWebPushSubscription[];
  preparedAtMs: number;
  stateDir?: string;
}): boolean {
  const subscriptionsById = new Map(
    params.subscriptions.map((subscription) => [subscription.subscriptionId, subscription]),
  );
  if (subscriptionsById.size === 0) {
    return false;
  }
  ensureWebPushApprovalDeliverySchema(params.stateDir);
  const options = webPushStateDatabaseOptions(params.stateDir);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<WebPushDatabase>(db);
    const approval = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("operator_approvals")
        .select("status")
        .where("approval_id", "=", params.approvalId),
    );
    if (approval?.status !== "pending") {
      return false;
    }
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("web_push_approval_deliveries")
        .values(
          [...subscriptionsById.values()].map((subscription) => ({
            approval_id: params.approvalId,
            subscription_id: subscription.subscriptionId,
            device_id: subscription.deviceId,
            user_profile_id: subscription.userProfileId,
            prepared_at_ms: params.preparedAtMs,
          })),
        )
        .onConflict((conflict) =>
          conflict.columns(["approval_id", "subscription_id"]).doUpdateSet({
            device_id: (eb) => eb.ref("excluded.device_id"),
            user_profile_id: (eb) => eb.ref("excluded.user_profile_id"),
            prepared_at_ms: params.preparedAtMs,
          }),
        ),
    );
    return true;
  }, options);
}

/** Load current targets and discard rows whose original browser ownership no longer matches. */
export function listWebPushApprovalDeliveryTargets(params: {
  approvalId: string;
  stateDir?: string;
}): BoundWebPushSubscription[] {
  ensureWebPushApprovalDeliverySchema(params.stateDir);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<WebPushDatabase>(db);
    const rows = executeSqliteQuerySync(
      db,
      stateDb
        .selectFrom("web_push_approval_deliveries")
        .innerJoin(
          "web_push_subscriptions",
          "web_push_subscriptions.subscription_id",
          "web_push_approval_deliveries.subscription_id",
        )
        .selectAll("web_push_subscriptions")
        .select([
          "web_push_approval_deliveries.device_id as delivery_device_id",
          "web_push_approval_deliveries.user_profile_id as delivery_user_profile_id",
        ])
        .where("web_push_approval_deliveries.approval_id", "=", params.approvalId)
        .orderBy("web_push_subscriptions.created_at_ms", "asc")
        .orderBy("web_push_subscriptions.subscription_id", "asc"),
    ).rows;
    const staleSubscriptionIds = new Set(
      rows
        .filter(
          (row) =>
            row.device_id !== row.delivery_device_id ||
            row.user_profile_id !== row.delivery_user_profile_id,
        )
        .map((row) => row.subscription_id),
    );
    if (staleSubscriptionIds.size > 0) {
      executeSqliteQuerySync(
        db,
        stateDb
          .deleteFrom("web_push_approval_deliveries")
          .where("approval_id", "=", params.approvalId)
          .where("subscription_id", "in", [...staleSubscriptionIds]),
      );
    }
    return rows.flatMap((row) => {
      if (staleSubscriptionIds.has(row.subscription_id)) {
        return [];
      }
      const subscription = boundWebPushSubscriptionFromRow(row);
      return subscription ? [subscription] : [];
    });
  }, webPushStateDatabaseOptions(params.stateDir));
}

/** Remove only targets whose terminal replacement was accepted. */
export function deleteWebPushApprovalDeliveryTargets(params: {
  approvalId: string;
  subscriptionIds: readonly string[];
  stateDir?: string;
}): void {
  const subscriptionIds = [...new Set(params.subscriptionIds)];
  if (subscriptionIds.length === 0) {
    return;
  }
  ensureWebPushApprovalDeliverySchema(params.stateDir);
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WebPushDatabase>(db)
        .deleteFrom("web_push_approval_deliveries")
        .where("approval_id", "=", params.approvalId)
        .where("subscription_id", "in", subscriptionIds),
    );
  }, webPushStateDatabaseOptions(params.stateDir));
}

/** Discover terminal approvals whose request notifications still need replacement. */
export function listTerminalWebPushApprovalDeliveryIds(stateDir?: string): {
  approvalIds: string[];
  truncated: boolean;
} {
  ensureWebPushApprovalDeliverySchema(stateDir);
  const database = openOpenClawStateDatabase(webPushStateDatabaseOptions(stateDir));
  const rows = executeSqliteQuerySync(
    database.db,
    getNodeSqliteKysely<WebPushDatabase>(database.db)
      .selectFrom("web_push_approval_deliveries")
      .innerJoin(
        "operator_approvals",
        "operator_approvals.approval_id",
        "web_push_approval_deliveries.approval_id",
      )
      .select("web_push_approval_deliveries.approval_id")
      .distinct()
      .where("operator_approvals.status", "!=", "pending")
      .orderBy("web_push_approval_deliveries.approval_id", "asc")
      .limit(WEB_PUSH_APPROVAL_RECOVERY_MAX_APPROVALS + 1),
  ).rows;
  return {
    approvalIds: rows
      .slice(0, WEB_PUSH_APPROVAL_RECOVERY_MAX_APPROVALS)
      .map((row) => row.approval_id),
    truncated: rows.length > WEB_PUSH_APPROVAL_RECOVERY_MAX_APPROVALS,
  };
}

/** Reread the endpoint row inside the write transaction before creating or updating it. */
export function upsertWebPushSubscription(params: {
  endpointHash: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  binding?: { deviceId: string; userProfileId: string | null };
  candidateSubscriptionId: string;
  nowMs: number;
  stateDir?: string;
}): WebPushSubscription {
  ensureWebPushSubscriptionBindingSchema(params.stateDir);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const stateDb = getNodeSqliteKysely<WebPushDatabase>(db);
    const existingRow = executeSqliteQueryTakeFirstSync(
      db,
      stateDb
        .selectFrom("web_push_subscriptions")
        .selectAll()
        .where("endpoint_hash", "=", params.endpointHash),
    );
    if (existingRow && existingRow.endpoint !== params.endpoint) {
      throw new Error("web push endpoint hash collision");
    }
    const subscription: WebPushSubscription = {
      subscriptionId: existingRow?.subscription_id ?? params.candidateSubscriptionId,
      endpoint: params.endpoint,
      keys: { ...params.keys },
      createdAtMs: existingRow?.created_at_ms ?? params.nowMs,
      updatedAtMs: params.nowMs,
    };
    const row = webPushSubscriptionToRow({
      endpointHash: params.endpointHash,
      subscription,
      binding: params.binding,
    });
    // Device preferences belong to the exact browser/profile binding. Key refreshes
    // preserve them; ownership transfer resets them before the new owner can read.
    const bindingChanged = Boolean(
      existingRow &&
      (existingRow.device_id !== row.device_id ||
        existingRow.user_profile_id !== row.user_profile_id),
    );
    executeSqliteQuerySync(
      db,
      stateDb
        .insertInto("web_push_subscriptions")
        .values(row)
        .onConflict((conflict) =>
          conflict.column("endpoint_hash").doUpdateSet({
            subscription_id: row.subscription_id,
            endpoint: row.endpoint,
            p256dh: row.p256dh,
            auth: row.auth,
            device_id: row.device_id,
            user_profile_id: row.user_profile_id,
            preferences_json: bindingChanged ? null : (existingRow?.preferences_json ?? null),
            updated_at_ms: row.updated_at_ms,
          }),
        ),
    );
    return subscription;
  }, webPushStateDatabaseOptions(params.stateDir));
}

export function deleteWebPushSubscriptionByEndpoint(params: {
  endpointHash: string;
  endpoint: string;
  stateDir?: string;
}): boolean {
  ensureWebPushSubscriptionBindingSchema(params.stateDir);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WebPushDatabase>(db)
        .deleteFrom("web_push_subscriptions")
        .where("endpoint_hash", "=", params.endpointHash)
        .where("endpoint", "=", params.endpoint),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, webPushStateDatabaseOptions(params.stateDir));
}

/** Delete an expired send target only if no newer registration replaced it in flight. */
export function deleteWebPushSubscriptionIfCurrent(params: {
  endpointHash: string;
  subscription: WebPushSubscription;
  stateDir?: string;
}): boolean {
  const subscription = params.subscription;
  ensureWebPushSubscriptionBindingSchema(params.stateDir);
  return runOpenClawStateWriteTransaction(({ db }) => {
    const result = executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<WebPushDatabase>(db)
        .deleteFrom("web_push_subscriptions")
        .where("endpoint_hash", "=", params.endpointHash)
        .where("subscription_id", "=", subscription.subscriptionId)
        .where("endpoint", "=", subscription.endpoint)
        .where("p256dh", "=", subscription.keys.p256dh)
        .where("auth", "=", subscription.keys.auth)
        .where("updated_at_ms", "=", subscription.updatedAtMs),
    );
    return Number(result.numAffectedRows ?? 0) > 0;
  }, webPushStateDatabaseOptions(params.stateDir));
}

export function readPersistedVapidKeyPair(stateDir?: string): VapidKeyPair | null {
  return (
    readConfigMachineState<VapidKeyPair>(
      WEB_PUSH_VAPID_STATE_KEY,
      webPushStateDatabaseOptions(stateDir),
    ) ?? null
  );
}

/** First committed keypair wins so concurrent gateway bootstraps share one signing identity. */
export function insertVapidKeyPairIfAbsent(params: {
  candidate: VapidKeyPair;
  nowMs: number;
  stateDir?: string;
}): VapidKeyPair {
  return updateConfigMachineState<VapidKeyPair>(
    WEB_PUSH_VAPID_STATE_KEY,
    (current) => current ?? params.candidate,
    webPushStateDatabaseOptions(params.stateDir),
  );
}

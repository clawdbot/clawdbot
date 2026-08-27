// Canonical shared-SQLite store for Web Push subscriptions and VAPID identity.
import type { Insertable, Selectable } from "kysely";
import { readConfigMachineState, updateConfigMachineState } from "../state/config-machine-state.js";
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

export const WEB_PUSH_VAPID_STATE_KEY = "webPush.vapidKeys";
export const DEFAULT_WEB_PUSH_VAPID_SUBJECT = "https://openclaw.ai";
const WEB_PUSH_MAX_ENDPOINT_LENGTH = 2048;
const WEB_PUSH_MAX_KEY_LENGTH = 512;

export type WebPushSubscription = {
  subscriptionId: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  createdAtMs: number;
  updatedAtMs: number;
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
  "config_machine_state" | "web_push_subscriptions"
>;
type WebPushSubscriptionRow = Selectable<WebPushDatabase["web_push_subscriptions"]>;
type WebPushSubscriptionInsert = Insertable<WebPushDatabase["web_push_subscriptions"]>;

function webPushStateDatabaseOptions(stateDir?: string): OpenClawStateDatabaseOptions {
  return stateDir
    ? { env: { ...process.env, OPENCLAW_STATE_DIR: stateDir } }
    : { env: process.env };
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

export function webPushSubscriptionToRow(params: {
  endpointHash: string;
  subscription: WebPushSubscription;
}): WebPushSubscriptionInsert {
  return {
    endpoint_hash: params.endpointHash,
    subscription_id: params.subscription.subscriptionId,
    endpoint: params.subscription.endpoint,
    p256dh: params.subscription.keys.p256dh,
    auth: params.subscription.keys.auth,
    created_at_ms: params.subscription.createdAtMs,
    updated_at_ms: params.subscription.updatedAtMs,
  };
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

/** Reread the endpoint row inside the write transaction before creating or updating it. */
export function upsertWebPushSubscription(params: {
  endpointHash: string;
  endpoint: string;
  keys: { p256dh: string; auth: string };
  candidateSubscriptionId: string;
  nowMs: number;
  stateDir?: string;
}): WebPushSubscription {
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
    });
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

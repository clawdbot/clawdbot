import type { DatabaseSync } from "node:sqlite";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Selectable } from "kysely";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getDeliveryQueueEntryStatus } from "../infra/delivery-queue-sqlite.js";
import { createTimeZoneDayKeyFormatter } from "../infra/format-time/format-datetime.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { generateSecureUuid } from "../infra/secure-random.js";
import { runSqliteImmediateTransactionSync } from "../infra/sqlite-transaction.js";
import type { Model } from "../llm/types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { isPrivateOwnerRouteTarget } from "../routing/private-owner-route.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../state/openclaw-agent-db.js";
import { ensureOpenClawAgentModelSpendSchemaInTransaction } from "../state/openclaw-agent-model-spend-schema.js";
import { isUsdRepresentableAsMicroUsd, MICRO_USD_PER_USD } from "../utils/micro-usd.js";
import {
  estimateUsageCost,
  resolveModelCostConfig,
  resolveUsageCostRates,
} from "../utils/usage-format.js";
import { resolveAgentConfig, resolveAgentDir } from "./agent-scope-config.js";
import { resolveUserTimezone } from "./date-time.js";
import { normalizeUsage, type UsageLike } from "./usage.js";

const PROCESSED_CALL_RETENTION_MS = 8 * 24 * 60 * 60 * 1000;
const MODEL_SPEND_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MODEL_SPEND_CLAIM_LEASE_MS = 30 * 60 * 1000;
const MODEL_SPEND_ALERT_BATCH_SIZE = 100;
// Matches the durable outbound queue that serializes ModelSpendAlertCompletion.
const MODEL_SPEND_DELIVERY_QUEUE_NAME = "outbound";
const log = createSubsystemLogger("agents/model-spend");

type ModelSpendDatabase = Pick<
  OpenClawAgentKyselyDatabase,
  "model_spend_alerts" | "model_spend_calls" | "model_spend_daily"
>;

type ModelSpendAlertRow = Selectable<OpenClawAgentKyselyDatabase["model_spend_alerts"]>;

export type ModelSpendTerminalCall = {
  accountingCallId: string;
  model: Model;
  usage?: UsageLike;
};

type ModelSpendAlertDeliveryTarget = {
  sessionKey?: string;
  channel?: string;
  to?: string;
  chatType?: string;
};

export type ModelSpendAlertCompletion = {
  agentId: string;
  alertIds: string[];
  deliveryIntentId: string;
};

export type PreparedModelSpendAlert = {
  alertIds: string[];
  deliveryIntentId: string;
  text: string;
};

type ResolvedModelSpendCost = {
  costMicroUsd: number;
  trackingComplete: boolean;
};

const ensuredModelSpendDatabases = new WeakSet<DatabaseSync>();

function ensureModelSpendSchema(database: OpenClawAgentDatabase): void {
  if (ensuredModelSpendDatabases.has(database.db)) {
    return;
  }
  if (database.db.isTransaction) {
    throw new Error("model-spend schema must be ensured before the write transaction starts");
  }
  runSqliteImmediateTransactionSync(
    database.db,
    () => ensureOpenClawAgentModelSpendSchemaInTransaction(database.db),
    {
      databaseLabel: database.path,
      operationLabel: "model-spend.ensure-schema",
    },
  );
  // Additive-surface rule: fold this into the next natural schema bump, then delete this lazy ensure.
  ensuredModelSpendDatabases.add(database.db);
}

function prepareModelSpendDatabase(agentId: string): OpenClawAgentDatabase {
  const database = openOpenClawAgentDatabase({ agentId: normalizeAgentId(agentId) });
  ensureModelSpendSchema(database);
  return database;
}

function runModelSpendWrite<T>(
  agentId: string,
  operationLabel: string,
  operation: (database: OpenClawAgentDatabase) => T,
): T {
  const database = prepareModelSpendDatabase(agentId);
  return runOpenClawAgentWriteTransaction(
    operation,
    { agentId, path: database.path },
    {
      operationLabel,
    },
  );
}

function ceilUsdToMicroUsd(value: number): number {
  const microUsd = Math.ceil(value * MICRO_USD_PER_USD);
  if (!Number.isSafeInteger(microUsd) || microUsd < 0) {
    throw new Error(`model-spend USD value is outside the supported range: ${value}`);
  }
  return microUsd;
}

function configuredUsdToMicroUsd(value: number): number {
  if (!isUsdRepresentableAsMicroUsd(value)) {
    throw new Error(`model-spend alert interval is not representable as micro-USD: ${value}`);
  }
  return Math.round(value * MICRO_USD_PER_USD);
}

export function resolveModelSpendCostMicroUsd(params: {
  model: Model;
  usage?: UsageLike;
  cfg?: OpenClawConfig;
  agentId?: string;
}): ResolvedModelSpendCost {
  const providerBilledTotal = params.usage?.cost?.total;
  if (
    params.usage?.cost?.totalOrigin === "provider-billed" &&
    typeof providerBilledTotal === "number" &&
    Number.isFinite(providerBilledTotal) &&
    providerBilledTotal >= 0
  ) {
    return { costMicroUsd: ceilUsdToMicroUsd(providerBilledTotal), trackingComplete: true };
  }

  const usage = normalizeUsage(params.usage);
  if (!usage) {
    return { costMicroUsd: 0, trackingComplete: false };
  }
  const buckets = [usage.input, usage.output, usage.cacheRead, usage.cacheWrite];
  const knownTokenTotal = buckets.reduce<number>((sum, bucket) => sum + (bucket ?? 0), 0);
  const allBucketsKnown = buckets.every((bucket) => bucket !== undefined);
  const totalReconciles = usage.total !== undefined && usage.total === knownTokenTotal;
  const usageComplete =
    (allBucketsKnown || totalReconciles) && (usage.total === undefined || totalReconciles);
  const resolvedCost = params.cfg
    ? resolveModelCostConfig({
        provider: params.model.provider,
        model: params.model.id,
        config: params.cfg,
        ...(params.agentId ? { agentDir: resolveAgentDir(params.cfg, params.agentId) } : {}),
      })
    : undefined;
  const cost = resolvedCost ?? params.model.cost;
  const usd = estimateUsageCost({ usage, cost });
  const rates = resolveUsageCostRates({ usage, cost });
  const pricingComplete =
    rates !== undefined &&
    usd !== undefined &&
    usd >= 0 &&
    [
      { tokens: usage.input, rate: rates.input },
      { tokens: usage.output, rate: rates.output },
      { tokens: usage.cacheRead, rate: rates.cacheRead },
      { tokens: usage.cacheWrite, rate: rates.cacheWrite },
    ].every(
      (bucket) => (bucket.tokens ?? 0) <= 0 || (Number.isFinite(bucket.rate) && bucket.rate > 0),
    );
  return {
    costMicroUsd: ceilUsdToMicroUsd(pricingComplete ? usd : 0),
    trackingComplete: usageComplete && pricingComplete,
  };
}

function insertTrackingIncompleteAlert(params: {
  db: ReturnType<typeof getNodeSqliteKysely<ModelSpendDatabase>>;
  database: OpenClawAgentDatabase;
  dayKey: string;
  timeZone: string;
  provider: string;
  targetSessionKey: string | null;
  nowMs: number;
}): void {
  executeSqliteQuerySync(
    params.database.db,
    params.db
      .insertInto("model_spend_alerts")
      .values({
        alert_id: `model-spend:${params.dayKey}:${params.timeZone}:${params.provider}:tracking-incomplete`,
        day_key: params.dayKey,
        timezone: params.timeZone,
        provider: params.provider,
        kind: "tracking_incomplete",
        target_session_key: params.targetSessionKey,
        spend_microusd: 0,
        first_threshold_microusd: null,
        highest_threshold_microusd: null,
        status: "pending",
        queue_id: null,
        created_at: params.nowMs,
        updated_at: params.nowMs,
        delivered_at: null,
      })
      .onConflict((conflict) => conflict.column("alert_id").doNothing()),
  );
}

function addCostAndMaybeCreateThresholdAlert(params: {
  db: ReturnType<typeof getNodeSqliteKysely<ModelSpendDatabase>>;
  database: OpenClawAgentDatabase;
  accountingCallId: string;
  dayKey: string;
  timeZone: string;
  provider: string;
  costMicroUsd: number;
  thresholdMicroUsd: number;
  targetSessionKey: string | null;
  nowMs: number;
}): void {
  const current = executeSqliteQuerySync(
    params.database.db,
    params.db
      .selectFrom("model_spend_daily")
      .select("spend_microusd")
      .where("day_key", "=", params.dayKey)
      .where("timezone", "=", params.timeZone)
      .where("provider", "=", params.provider)
      .limit(1),
  ).rows[0];
  const priorSpend = current?.spend_microusd ?? 0;
  const nextSpend = priorSpend + params.costMicroUsd;
  if (!Number.isSafeInteger(nextSpend)) {
    throw new Error("model-spend daily total exceeded the supported integer range");
  }
  const priorCurrentThreshold =
    Math.floor(priorSpend / params.thresholdMicroUsd) * params.thresholdMicroUsd;
  const nextHighestThreshold =
    Math.floor(nextSpend / params.thresholdMicroUsd) * params.thresholdMicroUsd;
  executeSqliteQuerySync(
    params.database.db,
    params.db
      .insertInto("model_spend_daily")
      .values({
        day_key: params.dayKey,
        timezone: params.timeZone,
        provider: params.provider,
        spend_microusd: nextSpend,
        updated_at: params.nowMs,
      })
      .onConflict((conflict) =>
        conflict.columns(["day_key", "timezone", "provider"]).doUpdateSet({
          spend_microusd: nextSpend,
          updated_at: params.nowMs,
        }),
      ),
  );
  if (nextHighestThreshold <= priorCurrentThreshold) {
    return;
  }
  executeSqliteQuerySync(
    params.database.db,
    params.db.insertInto("model_spend_alerts").values({
      alert_id: `model-spend:${params.dayKey}:${params.provider}:threshold:${params.accountingCallId}`,
      day_key: params.dayKey,
      timezone: params.timeZone,
      provider: params.provider,
      kind: "threshold",
      target_session_key: params.targetSessionKey,
      spend_microusd: nextSpend,
      first_threshold_microusd: priorCurrentThreshold + params.thresholdMicroUsd,
      highest_threshold_microusd: nextHighestThreshold,
      status: "pending",
      queue_id: null,
      created_at: params.nowMs,
      updated_at: params.nowMs,
      delivered_at: null,
    }),
  );
}

function recoverExpiredModelSpendAlertClaims(agentId: string, nowMs: number): void {
  const cutoff = nowMs - MODEL_SPEND_CLAIM_LEASE_MS;
  const database = prepareModelSpendDatabase(agentId);
  const db = getNodeSqliteKysely<ModelSpendDatabase>(database.db);
  const expired = executeSqliteQuerySync(
    database.db,
    db
      .selectFrom("model_spend_alerts")
      .select(["alert_id", "queue_id"])
      .where("status", "=", "claimed")
      .where("updated_at", "<=", cutoff),
  ).rows;
  const orphanedIntentIds = [
    ...new Set(
      expired
        .map((row) => row.queue_id)
        .filter((queueId): queueId is string => queueId !== null)
        .filter(
          (queueId) =>
            getDeliveryQueueEntryStatus(MODEL_SPEND_DELIVERY_QUEUE_NAME, queueId) === undefined,
        ),
    ),
  ];
  if (orphanedIntentIds.length === 0) {
    return;
  }
  // Recheck the lease and token under the agent DB write lock. A live or recovered
  // durable intent remains authoritative and is never made replayable here.
  runModelSpendWrite(agentId, "model-spend.recover-claims", (writeDatabase) => {
    const writeDb = getNodeSqliteKysely<ModelSpendDatabase>(writeDatabase.db);
    executeSqliteQuerySync(
      writeDatabase.db,
      writeDb
        .updateTable("model_spend_alerts")
        .set({ status: "pending", queue_id: null, updated_at: nowMs })
        .where("status", "=", "claimed")
        .where("updated_at", "<=", cutoff)
        .where("queue_id", "in", orphanedIntentIds),
    );
  });
}

function resolveModelSpendTargetSessionKey(params: {
  cfg: OpenClawConfig;
  deliveryTarget?: ModelSpendAlertDeliveryTarget;
}): string | null {
  const sessionKey = normalizeOptionalString(params.deliveryTarget?.sessionKey);
  const channel = normalizeOptionalString(params.deliveryTarget?.channel);
  const to = normalizeOptionalString(params.deliveryTarget?.to);
  if (
    !sessionKey ||
    !channel ||
    !to ||
    normalizeChatType(params.deliveryTarget?.chatType) !== "direct"
  ) {
    return null;
  }
  return isPrivateOwnerRouteTarget({ cfg: params.cfg, channel, to }) ? sessionKey : null;
}

/** Records one real text-provider call and creates any newly crossed daily alert. */
export function recordConfiguredModelSpendCall(params: {
  cfg: OpenClawConfig;
  agentId: string;
  deliveryTarget?: ModelSpendAlertDeliveryTarget;
  call: ModelSpendTerminalCall;
  nowMs?: number;
}): "not_configured" | "provider_not_monitored" | "duplicate" | "recorded" {
  const spendConfig = resolveAgentConfig(params.cfg, params.agentId)?.modelSpend;
  if (!spendConfig) {
    return "not_configured";
  }
  const provider = normalizeLowercaseStringOrEmpty(params.call.model.provider);
  if (!spendConfig.providers.includes(provider)) {
    return "provider_not_monitored";
  }
  const nowMs = params.nowMs ?? Date.now();
  const timeZone = resolveUserTimezone(params.cfg.agents?.defaults?.userTimezone);
  const dayKey = createTimeZoneDayKeyFormatter(timeZone)(new Date(nowMs));
  const targetSessionKey = resolveModelSpendTargetSessionKey(params);
  const cost = resolveModelSpendCostMicroUsd({
    model: params.call.model,
    usage: params.call.usage,
    cfg: params.cfg,
    agentId: params.agentId,
  });
  const thresholdMicroUsd = configuredUsdToMicroUsd(spendConfig.dailyAlertEveryUsd);

  return runModelSpendWrite(params.agentId, "model-spend.record-call", (database) => {
    const db = getNodeSqliteKysely<ModelSpendDatabase>(database.db);
    const inserted = executeSqliteQuerySync(
      database.db,
      db
        .insertInto("model_spend_calls")
        .values({
          accounting_call_id: params.call.accountingCallId,
          day_key: dayKey,
          timezone: timeZone,
          provider,
          cost_microusd: cost.trackingComplete ? cost.costMicroUsd : null,
          created_at: nowMs,
        })
        .onConflict((conflict) => conflict.column("accounting_call_id").doNothing()),
    );
    if (inserted.numAffectedRows !== 1n) {
      return "duplicate";
    }
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("model_spend_calls")
        .where("created_at", "<", nowMs - PROCESSED_CALL_RETENTION_MS),
    );
    const historyCutoff = nowMs - MODEL_SPEND_HISTORY_RETENTION_MS;
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("model_spend_alerts")
        .where("status", "in", ["delivered", "unknown"])
        .where("updated_at", "<", historyCutoff),
    );
    executeSqliteQuerySync(
      database.db,
      db.deleteFrom("model_spend_daily").where("updated_at", "<", historyCutoff),
    );
    if (!cost.trackingComplete) {
      insertTrackingIncompleteAlert({
        db,
        database,
        dayKey,
        timeZone,
        provider,
        targetSessionKey,
        nowMs,
      });
    }
    if (cost.costMicroUsd > 0) {
      addCostAndMaybeCreateThresholdAlert({
        db,
        database,
        accountingCallId: params.call.accountingCallId,
        dayKey,
        timeZone,
        provider,
        costMicroUsd: cost.costMicroUsd,
        thresholdMicroUsd,
        targetSessionKey,
        nowMs,
      });
    }
    return "recorded";
  });
}

function formatUsd(microUsd: number): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(microUsd / MICRO_USD_PER_USD);
}

function formatThresholdRanges(rows: ModelSpendAlertRow[]): string {
  return rows
    .map((row) => ({
      first: row.first_threshold_microusd ?? Number.MAX_SAFE_INTEGER,
      highest: row.highest_threshold_microusd ?? 0,
    }))
    .toSorted((a, b) => a.first - b.first || a.highest - b.highest)
    .map((range) =>
      range.first === range.highest
        ? formatUsd(range.highest)
        : `${formatUsd(range.first)} through ${formatUsd(range.highest)}`,
    )
    .join(", ");
}

function formatPendingAlerts(rows: ModelSpendAlertRow[]): string {
  const lines: string[] = [];
  const days = [...new Set(rows.map((row) => row.day_key))].toSorted();
  for (const day of days) {
    const dayRows = rows.filter((row) => row.day_key === day);
    const timeZones = [...new Set(dayRows.map((row) => row.timezone))].toSorted();
    for (const timeZone of timeZones) {
      const timeZoneRows = dayRows.filter((row) => row.timezone === timeZone);
      const providers = [...new Set(timeZoneRows.map((row) => row.provider))].toSorted();
      for (const provider of providers) {
        const providerRows = timeZoneRows.filter((row) => row.provider === provider);
        const thresholdRows = providerRows.filter((row) => row.kind === "threshold");
        if (thresholdRows.length > 0) {
          const spend = Math.max(...thresholdRows.map((row) => row.spend_microusd));
          lines.push(
            `Model spend alert: ${provider} reached ${formatUsd(spend)} on ${day} ` +
              `(crossed ${formatThresholdRanges(thresholdRows)}; daily reset: ${timeZone}).`,
          );
        }
        if (providerRows.some((row) => row.kind === "tracking_incomplete")) {
          lines.push(
            `Model spend tracking is incomplete for ${provider} on ${day} because usage or pricing data was unavailable.`,
          );
        }
      }
    }
  }
  return lines.map((line) => `Warning: ${line}`).join("\n");
}

/** Atomically claims alerts for one final visible reply before it builds a durable send. */
export function preparePendingModelSpendAlert(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string;
}): PreparedModelSpendAlert | undefined {
  if (!resolveAgentConfig(params.cfg, params.agentId)?.modelSpend) {
    return undefined;
  }
  const nowMs = Date.now();
  recoverExpiredModelSpendAlertClaims(params.agentId, nowMs);
  const deliveryIntentId = `model-spend-${generateSecureUuid()}`;
  return runModelSpendWrite(params.agentId, "model-spend.prepare-alert", (database) => {
    const db = getNodeSqliteKysely<ModelSpendDatabase>(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("model_spend_alerts")
        .selectAll()
        .where("status", "=", "pending")
        .where((eb) =>
          params.sessionKey === undefined
            ? eb("target_session_key", "is", null)
            : eb.or([
                eb("target_session_key", "is", null),
                eb("target_session_key", "=", params.sessionKey),
              ]),
        )
        .orderBy((eb) =>
          eb
            .case()
            .when("target_session_key", "=", params.sessionKey ?? null)
            .then(0)
            .else(1)
            .end(),
        )
        .orderBy("created_at", "asc")
        .orderBy("alert_id", "asc")
        .limit(MODEL_SPEND_ALERT_BATCH_SIZE),
    ).rows;
    if (rows.length === 0) {
      return undefined;
    }
    const alertIds = rows.map((row) => row.alert_id);
    const claimed = executeSqliteQuerySync(
      database.db,
      db
        .updateTable("model_spend_alerts")
        .set({ status: "claimed", queue_id: deliveryIntentId, updated_at: nowMs })
        .where("alert_id", "in", alertIds)
        .where("status", "=", "pending"),
    );
    if (claimed.numAffectedRows !== BigInt(alertIds.length)) {
      throw new Error("model-spend alert claim changed during its write transaction");
    }
    return {
      alertIds,
      deliveryIntentId,
      text: formatPendingAlerts(rows),
    };
  });
}

/** Best-effort hot-path wrapper: spend tracking must never block a visible reply. */
export function preparePendingModelSpendAlertBestEffort(
  params: Parameters<typeof preparePendingModelSpendAlert>[0],
): PreparedModelSpendAlert | undefined {
  try {
    return preparePendingModelSpendAlert(params);
  } catch (error) {
    log.warn(`model-spend alert preparation failed: ${String(error)}`);
    return undefined;
  }
}

function normalizeAlertIds(alertIds: readonly string[]): string[] {
  return [...new Set(alertIds.map((id) => id.trim()).filter(Boolean))];
}

function selectOwnedModelSpendAlerts(params: {
  database: OpenClawAgentDatabase;
  completion: ModelSpendAlertCompletion;
  alertIds: string[];
}): { rows: ModelSpendAlertRow[]; terminal: boolean } {
  const db = getNodeSqliteKysely<ModelSpendDatabase>(params.database.db);
  const rows = executeSqliteQuerySync(
    params.database.db,
    db.selectFrom("model_spend_alerts").selectAll().where("alert_id", "in", params.alertIds),
  ).rows;
  if (rows.length !== params.alertIds.length) {
    throw new Error("model-spend alert delivery references missing owner state");
  }
  const terminal = rows.every((row) => row.status === "delivered" || row.status === "unknown");
  if (terminal) {
    return { rows, terminal };
  }
  if (
    !rows.every(
      (row) =>
        (row.status === "claimed" || row.status === "queued") &&
        row.queue_id === params.completion.deliveryIntentId,
    )
  ) {
    throw new Error("model-spend alert delivery ownership changed");
  }
  return { rows, terminal };
}

/** Associates pending alerts with a durable queue entry and reports prior completion. */
export function markModelSpendAlertsQueued(
  completion: ModelSpendAlertCompletion,
  queueId: string,
): { status: "queued" | "sent" } {
  const alertIds = normalizeAlertIds(completion.alertIds);
  if (alertIds.length === 0) {
    return { status: "sent" };
  }
  if (queueId !== completion.deliveryIntentId) {
    throw new Error("model-spend alert queue id does not match its delivery intent");
  }
  return runModelSpendWrite(completion.agentId, "model-spend.mark-queued", (database) => {
    const db = getNodeSqliteKysely<ModelSpendDatabase>(database.db);
    const owner = selectOwnedModelSpendAlerts({ database, completion, alertIds });
    if (owner.terminal) {
      return { status: "sent" };
    }
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("model_spend_alerts")
        .set({ status: "queued", updated_at: Date.now() })
        .where("alert_id", "in", alertIds)
        .where("queue_id", "=", completion.deliveryIntentId)
        .where("status", "in", ["claimed", "queued"]),
    );
    return { status: "queued" };
  });
}

/** Marks alert payloads delivered after identified platform send evidence. */
export function markModelSpendAlertsDelivered(completion: ModelSpendAlertCompletion): void {
  const alertIds = normalizeAlertIds(completion.alertIds);
  if (alertIds.length === 0) {
    return;
  }
  runModelSpendWrite(completion.agentId, "model-spend.mark-delivered", (database) => {
    const db = getNodeSqliteKysely<ModelSpendDatabase>(database.db);
    const owner = selectOwnedModelSpendAlerts({ database, completion, alertIds });
    if (owner.terminal) {
      return;
    }
    const nowMs = Date.now();
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("model_spend_alerts")
        .set({ status: "delivered", updated_at: nowMs, delivered_at: nowMs })
        .where("alert_id", "in", alertIds)
        .where("queue_id", "=", completion.deliveryIntentId)
        .where("status", "in", ["claimed", "queued"]),
    );
  });
}

/** Releases an unconfirmed alert so a later visible reply can carry it. */
export function releaseModelSpendAlerts(completion: ModelSpendAlertCompletion): void {
  const alertIds = normalizeAlertIds(completion.alertIds);
  if (alertIds.length === 0) {
    return;
  }
  runModelSpendWrite(completion.agentId, "model-spend.release", (database) => {
    const db = getNodeSqliteKysely<ModelSpendDatabase>(database.db);
    const owner = selectOwnedModelSpendAlerts({ database, completion, alertIds });
    if (owner.terminal) {
      return;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("model_spend_alerts")
        .set({ status: "pending", queue_id: null, updated_at: Date.now(), delivered_at: null })
        .where("alert_id", "in", alertIds)
        .where("queue_id", "=", completion.deliveryIntentId)
        .where("status", "in", ["claimed", "queued"]),
    );
  });
}

/** Releases only a claim that failed before a durable queue entry took ownership. */
export function releasePreparedModelSpendAlerts(completion: ModelSpendAlertCompletion): void {
  const alertIds = normalizeAlertIds(completion.alertIds);
  if (alertIds.length === 0) {
    return;
  }
  runModelSpendWrite(completion.agentId, "model-spend.release-prepared", (database) => {
    const db = getNodeSqliteKysely<ModelSpendDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("model_spend_alerts")
        .set({ status: "pending", queue_id: null, updated_at: Date.now() })
        .where("alert_id", "in", alertIds)
        .where("queue_id", "=", completion.deliveryIntentId)
        .where("status", "=", "claimed"),
    );
  });
}

/** Best-effort cleanup for failures that occur before the queue intent callback. */
export function releasePreparedModelSpendAlertsBestEffort(
  completion: ModelSpendAlertCompletion,
): void {
  try {
    releasePreparedModelSpendAlerts(completion);
  } catch (error) {
    log.warn(`model-spend prepared alert release failed: ${String(error)}`);
  }
}

/** Makes an alert terminal when the platform send outcome cannot be reconciled safely. */
export function markModelSpendAlertsUnknown(completion: ModelSpendAlertCompletion): void {
  const alertIds = normalizeAlertIds(completion.alertIds);
  if (alertIds.length === 0) {
    return;
  }
  runModelSpendWrite(completion.agentId, "model-spend.mark-unknown", (database) => {
    const db = getNodeSqliteKysely<ModelSpendDatabase>(database.db);
    const owner = selectOwnedModelSpendAlerts({ database, completion, alertIds });
    if (owner.terminal) {
      return;
    }
    executeSqliteQuerySync(
      database.db,
      db
        .updateTable("model_spend_alerts")
        .set({ status: "unknown", updated_at: Date.now() })
        .where("alert_id", "in", alertIds)
        .where("queue_id", "=", completion.deliveryIntentId)
        .where("status", "in", ["claimed", "queued"]),
    );
  });
}

import type { DatabaseSync } from "node:sqlite";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import type { Selectable } from "kysely";
import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTimeZoneDayKeyFormatter } from "../infra/format-time/format-datetime.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
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
import { resolveAgentConfig } from "./agent-scope-config.js";
import { resolveUserTimezone } from "./date-time.js";
import { resolveModelSpendCostMicroUsd } from "./model-spend-cost.js";
import type { UsageLike } from "./usage.js";

const MODEL_SPEND_HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MODEL_SPEND_ALERT_BATCH_SIZE = 100;
const log = createSubsystemLogger("agents/model-spend");

type ModelSpendDatabase = Pick<OpenClawAgentKyselyDatabase, "model_spend_daily">;
type ModelSpendDailyRow = Selectable<OpenClawAgentKyselyDatabase["model_spend_daily"]>;

type ModelSpendTerminalCall = {
  model: Model;
  usage?: UsageLike;
};

type PendingModelSpendAlert = {
  row: ModelSpendDailyRow;
  firstThresholdMicroUsd?: number;
  highestThresholdMicroUsd?: number;
  trackingIncomplete: boolean;
};

type PreparedModelSpendAlert = {
  text: string;
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

function configuredUsdToMicroUsd(value: number): number {
  if (!isUsdRepresentableAsMicroUsd(value)) {
    throw new Error(`model-spend alert interval is not representable as micro-USD: ${value}`);
  }
  return Math.round(value * MICRO_USD_PER_USD);
}

/**
 * Records one completed text-provider call without affecting the model call on failure.
 * The diagnostic stream wrapper emits exactly one terminal observation per provider call.
 */
export function recordConfiguredModelSpendCall(params: {
  cfg: OpenClawConfig;
  agentId: string;
  call: ModelSpendTerminalCall;
  nowMs?: number;
}): "not_configured" | "provider_not_monitored" | "recorded" {
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
  const cost = resolveModelSpendCostMicroUsd({
    model: params.call.model,
    usage: params.call.usage,
    cfg: params.cfg,
    agentId: params.agentId,
  });

  return runModelSpendWrite(params.agentId, "model-spend.record-call", (database) => {
    const db = getNodeSqliteKysely<ModelSpendDatabase>(database.db);
    executeSqliteQuerySync(
      database.db,
      db
        .deleteFrom("model_spend_daily")
        .where("updated_at", "<", nowMs - MODEL_SPEND_HISTORY_RETENTION_MS),
    );
    const current = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("model_spend_daily")
        .select(["spend_microusd", "tracking_incomplete"])
        .where("day_key", "=", dayKey)
        .where("timezone", "=", timeZone)
        .where("provider", "=", provider)
        .limit(1),
    ).rows[0];
    const nextSpend = (current?.spend_microusd ?? 0) + cost.costMicroUsd;
    if (!Number.isSafeInteger(nextSpend)) {
      throw new Error("model-spend daily total exceeded the supported integer range");
    }
    const trackingIncomplete = current?.tracking_incomplete === 1 || !cost.trackingComplete ? 1 : 0;
    executeSqliteQuerySync(
      database.db,
      db
        .insertInto("model_spend_daily")
        .values({
          day_key: dayKey,
          timezone: timeZone,
          provider,
          spend_microusd: nextSpend,
          last_alerted_threshold_microusd: 0,
          tracking_incomplete: trackingIncomplete,
          tracking_incomplete_alerted: 0,
          updated_at: nowMs,
        })
        .onConflict((conflict) =>
          conflict.columns(["day_key", "timezone", "provider"]).doUpdateSet({
            spend_microusd: nextSpend,
            tracking_incomplete: trackingIncomplete,
            updated_at: nowMs,
          }),
        ),
    );
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

function formatThresholdRange(first: number, highest: number): string {
  return first === highest
    ? formatUsd(highest)
    : `${formatUsd(first)} through ${formatUsd(highest)}`;
}

function formatPendingAlerts(alerts: PendingModelSpendAlert[]): string {
  const lines: string[] = [];
  for (const alert of alerts) {
    if (
      alert.firstThresholdMicroUsd !== undefined &&
      alert.highestThresholdMicroUsd !== undefined
    ) {
      lines.push(
        `Model spend alert: ${alert.row.provider} reached ${formatUsd(alert.row.spend_microusd)} ` +
          `on ${alert.row.day_key} (crossed ${formatThresholdRange(
            alert.firstThresholdMicroUsd,
            alert.highestThresholdMicroUsd,
          )}; daily reset: ${alert.row.timezone}).`,
      );
    }
    if (alert.trackingIncomplete) {
      lines.push(
        `Model spend tracking is incomplete for ${alert.row.provider} on ${alert.row.day_key} because usage or pricing data was unavailable.`,
      );
    }
  }
  return lines.map((line) => `Warning: ${line}`).join("\n");
}

function preparePendingModelSpendAlert(params: {
  cfg: OpenClawConfig;
  agentId: string;
}): PreparedModelSpendAlert | undefined {
  const spendConfig = resolveAgentConfig(params.cfg, params.agentId)?.modelSpend;
  if (!spendConfig) {
    return undefined;
  }
  const thresholdMicroUsd = configuredUsdToMicroUsd(spendConfig.dailyAlertEveryUsd);
  return runModelSpendWrite(params.agentId, "model-spend.prepare-alert", (database) => {
    const db = getNodeSqliteKysely<ModelSpendDatabase>(database.db);
    const rows = executeSqliteQuerySync(
      database.db,
      db
        .selectFrom("model_spend_daily")
        .selectAll()
        // Alert watermarks are provider-row scoped. Filter first so a removed
        // provider cannot reuse the current allowlist's interval.
        .where("provider", "in", spendConfig.providers)
        .orderBy("day_key", "asc")
        .orderBy("timezone", "asc")
        .orderBy("provider", "asc"),
    ).rows;
    const pending = rows
      .map((row): PendingModelSpendAlert | undefined => {
        const highestThresholdMicroUsd =
          Math.floor(row.spend_microusd / thresholdMicroUsd) * thresholdMicroUsd;
        const thresholdPending = highestThresholdMicroUsd > row.last_alerted_threshold_microusd;
        const trackingIncomplete =
          row.tracking_incomplete === 1 && row.tracking_incomplete_alerted === 0;
        if (!thresholdPending && !trackingIncomplete) {
          return undefined;
        }
        const firstThresholdMicroUsd = thresholdPending
          ? (Math.floor(row.last_alerted_threshold_microusd / thresholdMicroUsd) + 1) *
            thresholdMicroUsd
          : undefined;
        if (firstThresholdMicroUsd === undefined) {
          return { row, trackingIncomplete };
        }
        return {
          row,
          firstThresholdMicroUsd,
          highestThresholdMicroUsd,
          trackingIncomplete,
        };
      })
      .filter((alert): alert is PendingModelSpendAlert => alert !== undefined)
      .slice(0, MODEL_SPEND_ALERT_BATCH_SIZE);
    if (pending.length === 0) {
      return undefined;
    }

    // Advance before platform I/O. Delivery can fail and lose this informational
    // alert by design; model calls and visible replies must never depend on it.
    for (const alert of pending) {
      executeSqliteQuerySync(
        database.db,
        db
          .updateTable("model_spend_daily")
          .set({
            ...(alert.highestThresholdMicroUsd !== undefined
              ? { last_alerted_threshold_microusd: alert.highestThresholdMicroUsd }
              : {}),
            ...(alert.trackingIncomplete ? { tracking_incomplete_alerted: 1 } : {}),
          })
          .where("day_key", "=", alert.row.day_key)
          .where("timezone", "=", alert.row.timezone)
          .where("provider", "=", alert.row.provider),
      );
    }
    return { text: formatPendingAlerts(pending) };
  });
}

/** Best-effort hot-path wrapper: spend alerts must never block a visible reply. */
function preparePendingModelSpendAlertBestEffort(
  params: Parameters<typeof preparePendingModelSpendAlert>[0],
): PreparedModelSpendAlert | undefined {
  try {
    return preparePendingModelSpendAlert(params);
  } catch (error) {
    log.warn(`model-spend alert preparation failed: ${String(error)}`);
    return undefined;
  }
}

/** Attempts pending spend alerts only for an explicitly configured owner DM. */
export function preparePrivateOwnerModelSpendAlertBestEffort(params: {
  cfg: OpenClawConfig;
  agentId: string;
  channel?: string;
  to?: string;
  chatType?: string;
}): PreparedModelSpendAlert | undefined {
  const channel = normalizeOptionalString(params.channel);
  const to = normalizeOptionalString(params.to);
  if (
    !channel ||
    !to ||
    normalizeChatType(params.chatType) !== "direct" ||
    !isPrivateOwnerRouteTarget({ cfg: params.cfg, channel, to })
  ) {
    return undefined;
  }
  return preparePendingModelSpendAlertBestEffort({
    cfg: params.cfg,
    agentId: params.agentId,
  });
}

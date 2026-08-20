import { normalizeChatType } from "../channels/chat-type.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import {
  readUsageCostRollups,
  refreshCostUsageCacheForAgent,
  resolveUsageCostAgentDir,
  resolveUsageCostCacheDatabasePath,
  resolveUsageCostPricingFingerprint,
} from "../infra/session-cost-usage-aggregation.js";
import { requestCostUsageCacheRefresh } from "../infra/session-cost-usage-cache-runtime.js";
import { readSessionCostUsageRollupRows } from "../infra/session-cost-usage-cache.sqlite.js";
import { addRollupToCostUsageSummary } from "../infra/session-cost-usage-rollup.js";
import { createEmptyCostUsageTotals } from "../infra/session-cost-usage-totals.js";
import type { CostUsageTotals } from "../infra/session-cost-usage.types.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { normalizeAgentId } from "../routing/session-key.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import { isRecord } from "../utils.js";
import { resolveAgentConfig } from "./agent-scope-config.js";

const WARNING_SCOPE = "usage-budget-warning-v1";
const WARNING_STATE_KEY = "state";
// Discover all rollups once per cache/pricing identity; later replies refresh only
// their transcript, while a pricing change triggers a new full warmup.
const warmedPricingCaches = new Set<string>();
const warmingPricingCaches = new Set<string>();
const logger = createSubsystemLogger("usage-budget-warning");
const usdFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 6,
});

type AgentCacheDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

type UsageBudgetWarningParams = {
  cfg: OpenClawConfig;
  agentId: string;
  sessionFile?: string;
  chatType?: string;
  senderIsOwner?: boolean;
  nowMs?: number;
};

function resolveWarningIntervalUsd(params: UsageBudgetWarningParams): number | undefined {
  const budget =
    resolveAgentConfig(params.cfg, params.agentId)?.usageBudget ??
    params.cfg.agents?.defaults?.usageBudget;
  return budget && budget.enabled !== false && budget.action === "warn"
    ? budget.daily.usd
    : undefined;
}

function isPrivateOwnerRoute(params: UsageBudgetWarningParams): boolean {
  return params.senderIsOwner === true && normalizeChatType(params.chatType) === "direct";
}

function requestWarningUsageRefresh(params: UsageBudgetWarningParams): void {
  const agentId = normalizeAgentId(params.agentId);
  const agentDir = resolveUsageCostAgentDir(params.cfg, agentId);
  const databasePath = resolveUsageCostCacheDatabasePath(agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.cfg, agentDir);
  const warmKey = `${databasePath}\0${pricingFingerprint}`;
  if (!warmedPricingCaches.has(warmKey)) {
    if (!warmingPricingCaches.has(warmKey)) {
      warmingPricingCaches.add(warmKey);
      void Promise.resolve()
        .then(async () => {
          const result = await refreshCostUsageCacheForAgent({
            config: params.cfg,
            agentId,
            agentDir,
            databasePath,
          });
          if (result === "refreshed") {
            warmedPricingCaches.add(warmKey);
          }
        })
        .catch((error: unknown) => {
          logger.warn(`usage budget cache warmup failed: ${String(error)}`);
        })
        .finally(() => {
          warmingPricingCaches.delete(warmKey);
        });
    } else if (params.sessionFile) {
      requestCostUsageCacheRefresh({
        config: params.cfg,
        agentId,
        sessionFiles: [params.sessionFile],
      });
    }
    return;
  }
  if (params.sessionFile) {
    requestCostUsageCacheRefresh({
      config: params.cfg,
      agentId,
      sessionFiles: [params.sessionFile],
    });
  }
}

function loadCachedUtcDayUsage(params: UsageBudgetWarningParams): CostUsageTotals {
  const agentId = normalizeAgentId(params.agentId);
  const nowMs = params.nowMs ?? Date.now();
  const now = new Date(nowMs);
  const startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const agentDir = resolveUsageCostAgentDir(params.cfg, agentId);
  const databasePath = resolveUsageCostCacheDatabasePath(agentId);
  const pricingFingerprint = resolveUsageCostPricingFingerprint(params.cfg, agentDir);
  const rows = readSessionCostUsageRollupRows(agentId, databasePath, { updatedAtGte: startMs });
  const rollups = readUsageCostRollups(agentId, pricingFingerprint, databasePath, rows);
  const totals = createEmptyCostUsageTotals();
  const daily = new Map<string, CostUsageTotals>();
  for (const stored of rollups.values()) {
    addRollupToCostUsageSummary({
      rollup: stored.entry.rollup,
      startMs,
      endMs: nowMs,
      formatDay: utcDayKey,
      daily,
      totals,
    });
  }
  return totals;
}

function utcDayKey(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function claimWarningThreshold(params: {
  agentId: string;
  dayKey: string;
  intervalMicroUsd: number;
  thresholdMultiple: number;
  nowMs: number;
}): boolean {
  // Primary and queued result paths share one bounded state row per agent DB.
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<AgentCacheDatabase>(database.db);
      const current = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("cache_entries")
          .select("value_json")
          .where("scope", "=", WARNING_SCOPE)
          .where("key", "=", WARNING_STATE_KEY)
          .limit(1),
      ).rows[0]?.value_json;
      const parsed = current === null || current === undefined ? undefined : JSON.parse(current);
      const state = isRecord(parsed) ? parsed : undefined;
      const previous =
        state?.dayKey === params.dayKey && state.intervalMicroUsd === params.intervalMicroUsd
          ? Number(state.thresholdMultiple)
          : 0;
      if (Number.isFinite(previous) && previous >= params.thresholdMultiple) {
        return false;
      }
      executeSqliteQuerySync(
        database.db,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", WARNING_SCOPE)
          .where("key", "!=", WARNING_STATE_KEY),
      );
      executeSqliteQuerySync(
        database.db,
        kysely
          .insertInto("cache_entries")
          .values({
            scope: WARNING_SCOPE,
            key: WARNING_STATE_KEY,
            value_json: JSON.stringify({
              dayKey: params.dayKey,
              intervalMicroUsd: params.intervalMicroUsd,
              thresholdMultiple: params.thresholdMultiple,
            }),
            blob: null,
            expires_at: null,
            updated_at: params.nowMs,
          })
          .onConflict((conflict) =>
            conflict.columns(["scope", "key"]).doUpdateSet({
              value_json: JSON.stringify({
                dayKey: params.dayKey,
                intervalMicroUsd: params.intervalMicroUsd,
                thresholdMultiple: params.thresholdMultiple,
              }),
              updated_at: params.nowMs,
            }),
          ),
      );
      return true;
    },
    { agentId: normalizeAgentId(params.agentId) },
    { operationLabel: "usage-budget-warning.claim" },
  );
}

export function requestAgentUsageBudgetRefreshBestEffort(params: UsageBudgetWarningParams): void {
  try {
    if (resolveWarningIntervalUsd(params)) {
      requestWarningUsageRefresh(params);
    }
  } catch (error) {
    logger.warn(`usage budget refresh skipped: ${String(error)}`);
  }
}

export function prepareAgentUsageBudgetWarningBestEffort(
  params: UsageBudgetWarningParams,
): string | undefined {
  try {
    const intervalUsd = resolveWarningIntervalUsd(params);
    if (!intervalUsd || !isPrivateOwnerRoute(params)) {
      return undefined;
    }
    const nowMs = params.nowMs ?? Date.now();
    const usage = loadCachedUtcDayUsage({ ...params, nowMs });
    const intervalMicroUsd = Math.round(intervalUsd * 1_000_000);
    const spendMicroUsd = Math.max(0, Math.round(usage.totalCost * 1_000_000));
    const thresholdMultiple = Math.floor(spendMicroUsd / intervalMicroUsd);
    if (thresholdMultiple < 1) {
      return undefined;
    }
    if (
      !claimWarningThreshold({
        agentId: params.agentId,
        dayKey: utcDayKey(new Date(nowMs)),
        intervalMicroUsd,
        thresholdMultiple,
        nowMs,
      })
    ) {
      return undefined;
    }
    const thresholdUsd = (thresholdMultiple * intervalMicroUsd) / 1_000_000;
    const missing = usage.missingCostEntries;
    const knownSpend = `${missing > 0 ? "Known spend is at least " : "Spend is "}${usdFormatter.format(usage.totalCost)}`;
    return `Usage budget warning: ${knownSpend} UTC today, crossing ${usdFormatter.format(thresholdUsd)}. Warn-only mode; model calls continue.${missing > 0 ? ` ${missing} unpriced model call${missing === 1 ? " is" : "s are"} not included.` : ""}`;
  } catch (error) {
    logger.warn(`usage budget warning skipped: ${String(error)}`);
    return undefined;
  }
}

import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { NormalizedUsage, UsageLike } from "../agents/usage.js";
import { normalizeUsage } from "../agents/usage.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { countToolResults, extractToolCallNames } from "../utils/transcript-tools.js";
import { estimateUsageCost, resolveModelCostConfig } from "../utils/usage-format.js";
import type {
  CostBreakdown,
  CostUsageTotals,
  ParsedTranscriptEntry,
} from "./session-cost-usage.types.js";

const normalizeUsageCostTotalOrigin = (value: unknown): CostBreakdown["totalOrigin"] =>
  value === "provider-billed" ? value : undefined;

export const extractCostBreakdown = (usageRaw?: UsageLike | null): CostBreakdown | undefined => {
  if (!usageRaw || typeof usageRaw !== "object") {
    return undefined;
  }
  const record = usageRaw as Record<string, unknown>;
  const cost = record.cost as Record<string, unknown> | undefined;
  if (!cost) {
    return undefined;
  }

  const total = asFiniteNumber(cost.total);
  if (total === undefined || total < 0) {
    return undefined;
  }

  return {
    total,
    input: asFiniteNumber(cost.input),
    output: asFiniteNumber(cost.output),
    cacheRead: asFiniteNumber(cost.cacheRead),
    cacheWrite: asFiniteNumber(cost.cacheWrite),
    totalOrigin: normalizeUsageCostTotalOrigin(cost.totalOrigin),
  };
};

export const parseTimestamp = (entry: Record<string, unknown>): Date | undefined => {
  const message = entry.message as Record<string, unknown> | undefined;
  const messageTimestamp = asFiniteNumber(message?.timestamp);
  if (messageTimestamp !== undefined) {
    const parsed = new Date(messageTimestamp);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
  }
  const raw = entry.timestamp;
  if (typeof raw === "string") {
    const parsed = new Date(raw);
    if (!Number.isNaN(parsed.valueOf())) {
      return parsed;
    }
  }
  return undefined;
};

const parseTranscriptEntry = (entry: Record<string, unknown>): ParsedTranscriptEntry | null => {
  const message = entry.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") {
    return null;
  }

  const roleRaw = message.role;
  const role = roleRaw === "user" || roleRaw === "assistant" ? roleRaw : undefined;
  const isStandaloneToolResult = roleRaw === "tool" || roleRaw === "toolResult";
  if (!role && !isStandaloneToolResult) {
    return null;
  }

  const usageRaw =
    (message.usage as UsageLike | undefined) ?? (entry.usage as UsageLike | undefined);
  const usage = usageRaw ? (normalizeUsage(usageRaw) ?? undefined) : undefined;

  const provider =
    (typeof message.provider === "string" ? message.provider : undefined) ??
    (typeof entry.provider === "string" ? entry.provider : undefined);
  const model =
    (typeof message.model === "string" ? message.model : undefined) ??
    (typeof entry.model === "string" ? entry.model : undefined);

  const costBreakdown = extractCostBreakdown(usageRaw);
  const stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
  const durationMs = asFiniteNumber(message.durationMs ?? entry.durationMs);

  return {
    message,
    role,
    timestamp: parseTimestamp(entry),
    durationMs,
    usage,
    costTotal: costBreakdown?.total,
    costBreakdown,
    provider,
    model,
    stopReason,
    toolNames: isStandaloneToolResult ? [] : extractToolCallNames(message),
    toolResultCounts: isStandaloneToolResult
      ? {
          total: 1,
          errors: message.isError === true || message.is_error === true ? 1 : 0,
        }
      : countToolResults(message),
  };
};

export const computeUsageTokenTotals = (usage: NormalizedUsage) => {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  const componentTotal = input + output + cacheRead + cacheWrite;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    componentTotal,
    totalTokens: usage.total ?? componentTotal,
  };
};

export const applyUsageTotals = (totals: CostUsageTotals, usage: NormalizedUsage): void => {
  const usageTotals = computeUsageTokenTotals(usage);
  totals.input += usageTotals.input;
  totals.output += usageTotals.output;
  totals.cacheRead += usageTotals.cacheRead;
  totals.cacheWrite += usageTotals.cacheWrite;
  totals.totalTokens += usageTotals.totalTokens;
};

export const applyCostBreakdown = (
  totals: CostUsageTotals,
  costBreakdown: CostBreakdown | undefined,
): void => {
  if (costBreakdown === undefined || costBreakdown.total === undefined) {
    return;
  }
  totals.totalCost += costBreakdown.total;
  totals.inputCost += costBreakdown.input ?? 0;
  totals.outputCost += costBreakdown.output ?? 0;
  totals.cacheReadCost += costBreakdown.cacheRead ?? 0;
  totals.cacheWriteCost += costBreakdown.cacheWrite ?? 0;
};

// Legacy function for backwards compatibility (no cost breakdown available)
export const applyCostTotal = (
  totals: CostUsageTotals,
  costTotal: number | undefined,
  provider?: string,
  model?: string,
): void => {
  if (costTotal === undefined) {
    totals.missingCostEntries += 1;
    const modelKey = `${normalizeOptionalString(provider) ?? "unknown"}/${normalizeOptionalString(model) ?? "unknown"}`;
    totals.missingCostByModel ??= {};
    totals.missingCostByModel[modelKey] = (totals.missingCostByModel[modelKey] ?? 0) + 1;
    return;
  }
  totals.totalCost += costTotal;
};

// A resolved cost config counts as "known" pricing unless it is explicitly
// marked pricingUnavailable at the catalog boundary (placeholder zeros for
// providers that expose no price, e.g. codex model/list). Unmarked all-zero
// configs (e.g. Ollama's explicit free pricing, user-configured zeros) are a
// confirmed $0, matching the runtime completion path — one contract for both
// runtime emission and session aggregation. Missing pricing must never be
// reported as a confident $0, which would blind budget/spike safeguards.
const isModelPricingKnown = (cost: ReturnType<typeof resolveModelCostConfig>): boolean => {
  return cost !== undefined && cost !== null && cost.pricingUnavailable !== true;
};

const shouldPreserveRecordedZeroCost = (costBreakdown: CostBreakdown | undefined): boolean =>
  costBreakdown?.total === 0 &&
  (costBreakdown.totalOrigin === "provider-billed" ||
    [
      costBreakdown.input,
      costBreakdown.output,
      costBreakdown.cacheRead,
      costBreakdown.cacheWrite,
    ].some((value) => value !== undefined && value !== 0));

export const shouldRecomputeRecordedZeroCost = (params: {
  cost: ReturnType<typeof resolveModelCostConfig>;
  costBreakdown: CostBreakdown | undefined;
  costTotal: number | undefined;
  usage: NormalizedUsage;
}): boolean =>
  params.costTotal === 0 &&
  !shouldPreserveRecordedZeroCost(params.costBreakdown) &&
  isModelPricingKnown(params.cost) &&
  computeUsageTokenTotals(params.usage).totalTokens > 0;

export type UsageCostResolver = (params: {
  provider?: string;
  model?: string;
}) => ReturnType<typeof resolveModelCostConfig>;

export function createUsageCostResolver(params?: {
  config?: OpenClawConfig;
  agentDir?: string;
}): UsageCostResolver {
  const cache = new Map<string, ReturnType<typeof resolveModelCostConfig>>();
  return ({ provider, model }) => {
    const key = `${provider ?? ""}\0${model ?? ""}`;
    if (cache.has(key)) {
      return cache.get(key);
    }
    const cost = resolveModelCostConfig({
      provider,
      model,
      config: params?.config,
      agentDir: params?.agentDir,
    });
    cache.set(key, cost);
    return cost;
  };
}

export function parseUsageCostTranscriptEntry(
  parsed: Record<string, unknown>,
  resolveCost: UsageCostResolver,
): ParsedTranscriptEntry | null {
  const entry = parseTranscriptEntry(parsed);
  if (!entry?.usage) {
    return entry;
  }
  const cost = resolveCost({ provider: entry.provider, model: entry.model });
  const usageTotals = computeUsageTokenTotals(entry.usage);
  const pricingKnown = isModelPricingKnown(cost);
  const preserveRecordedZeroCost = shouldPreserveRecordedZeroCost(entry.costBreakdown);
  if (cost?.tieredPricing && cost.tieredPricing.length > 0 && !preserveRecordedZeroCost) {
    entry.costTotal = estimateUsageCost({ usage: entry.usage, cost });
    entry.costBreakdown = undefined;
  } else if (
    !pricingKnown &&
    !preserveRecordedZeroCost &&
    (entry.costTotal === undefined || entry.costTotal === 0) &&
    usageTotals.totalTokens > 0
  ) {
    entry.costTotal = undefined;
    entry.costBreakdown = undefined;
  } else if (
    entry.costTotal === undefined ||
    shouldRecomputeRecordedZeroCost({
      usage: entry.usage,
      cost,
      costBreakdown: entry.costBreakdown,
      costTotal: entry.costTotal,
    })
  ) {
    entry.costTotal = estimateUsageCost({ usage: entry.usage, cost });
    entry.costBreakdown = undefined;
  }
  return entry;
}

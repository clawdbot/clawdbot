// Shared arithmetic helpers for cost/usage token totals.
import type { CostUsageTotals } from "./session-cost-usage.types.js";

export function createEmptyCostUsageTotals(): CostUsageTotals {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

export function cloneCostUsageTotals(totals: CostUsageTotals): CostUsageTotals {
  return {
    input: totals.input,
    output: totals.output,
    cacheRead: totals.cacheRead,
    cacheWrite: totals.cacheWrite,
    totalTokens: totals.totalTokens,
    totalCost: totals.totalCost,
    inputCost: totals.inputCost,
    outputCost: totals.outputCost,
    cacheReadCost: totals.cacheReadCost,
    cacheWriteCost: totals.cacheWriteCost,
    missingCostEntries: totals.missingCostEntries,
    ...(totals.missingCostByModel ? { missingCostByModel: { ...totals.missingCostByModel } } : {}),
  };
}

export function addCostUsageTotals(target: CostUsageTotals, source: CostUsageTotals): void {
  target.input += source.input;
  target.output += source.output;
  target.cacheRead += source.cacheRead;
  target.cacheWrite += source.cacheWrite;
  target.totalTokens += source.totalTokens;
  target.totalCost += source.totalCost;
  target.inputCost += source.inputCost;
  target.outputCost += source.outputCost;
  target.cacheReadCost += source.cacheReadCost;
  target.cacheWriteCost += source.cacheWriteCost;
  target.missingCostEntries += source.missingCostEntries;
  if (source.missingCostByModel) {
    target.missingCostByModel ??= {};
    for (const [model, count] of Object.entries(source.missingCostByModel)) {
      target.missingCostByModel[model] = (target.missingCostByModel[model] ?? 0) + count;
    }
  }
}

export function formatMissingCostEntries(totals: CostUsageTotals): string {
  const byModel = Object.entries(totals.missingCostByModel ?? {})
    .filter(([, count]) => count > 0)
    .toSorted(
      ([modelA, countA], [modelB, countB]) => countB - countA || modelA.localeCompare(modelB),
    );
  if (byModel.length === 0) {
    return String(totals.missingCostEntries);
  }
  return `${totals.missingCostEntries} (${byModel.map(([model, count]) => `${model} ${count}`).join(", ")})`;
}

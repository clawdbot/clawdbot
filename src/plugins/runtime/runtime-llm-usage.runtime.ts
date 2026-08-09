// Runtime LLM usage-cost helpers: pricing provenance and costUsd assembly for
// plugin completion results. Split from runtime-llm.runtime.ts to keep both
// modules under the max-lines budget.
import { asFiniteNumberInRange } from "@openclaw/normalization-core";
import type { NormalizedUsage } from "../../agents/usage.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { estimateUsageCost, resolveModelCostConfig } from "../../utils/usage-format.js";
import type { LlmCompleteUsage } from "./types-core.js";

function readFiniteNonNegativeNumber(value: unknown): number | undefined {
  return asFiniteNumberInRange(value, { min: 0 });
}

function readExplicitCostUsd(raw: unknown): number | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return undefined;
  }
  const cost = (raw as { cost?: unknown }).cost;
  if (typeof cost === "number") {
    return readFiniteNonNegativeNumber(cost);
  }
  if (!cost || typeof cost !== "object" || Array.isArray(cost)) {
    return undefined;
  }
  // AssistantMessage usage always carries a cost object whose totals default to
  // zero, so a bare `total` cannot mark an explicit cost. Only a provider-billed
  // total is authoritative (see applyProviderReportedUsageCost); adapter-default
  // zeros fall through to the pricing-known estimate path.
  if ((cost as { totalOrigin?: unknown }).totalOrigin !== "provider-billed") {
    return undefined;
  }
  return (
    readFiniteNonNegativeNumber((cost as { total?: unknown; totalUsd?: unknown }).totalUsd) ??
    readFiniteNonNegativeNumber((cost as { total?: unknown }).total)
  );
}

// Pricing provenance for runtime usage cost. Unknown pricing (no cost config
// at all, or a placeholder-zero config marked pricingUnavailable at the
// catalog boundary — e.g. codex models whose backend exposes no price) must
// omit costUsd: reporting a confident $0 would silently blind budget/spike
// safeguards. All-zero rates WITHOUT the marker (e.g. Ollama's explicit free
// pricing, or user-configured zeros) are a known $0 and keep the established
// costUsd: 0 signal. Session cost aggregation shares the same contract, and
// the shared estimateUsageCost estimator independently honors the marker for
// direct consumers.
function isModelPricingKnown(cost: ReturnType<typeof resolveModelCostConfig>): boolean {
  return cost !== undefined && cost !== null && cost.pricingUnavailable !== true;
}

export function buildUsage(params: {
  rawUsage: unknown;
  normalized: NormalizedUsage | undefined;
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): LlmCompleteUsage {
  const costConfig = resolveModelCostConfig({
    provider: params.provider,
    model: params.model,
    config: params.cfg,
  });
  const explicitCostUsd = readExplicitCostUsd(params.rawUsage);
  const costUsd =
    explicitCostUsd ??
    (isModelPricingKnown(costConfig)
      ? estimateUsageCost({ usage: params.normalized, cost: costConfig })
      : undefined);
  return {
    ...(params.normalized?.input !== undefined ? { inputTokens: params.normalized.input } : {}),
    ...(params.normalized?.output !== undefined ? { outputTokens: params.normalized.output } : {}),
    ...(params.normalized?.cacheRead !== undefined
      ? { cacheReadTokens: params.normalized.cacheRead }
      : {}),
    ...(params.normalized?.cacheWrite !== undefined
      ? { cacheWriteTokens: params.normalized.cacheWrite }
      : {}),
    ...(params.normalized?.total !== undefined ? { totalTokens: params.normalized.total } : {}),
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

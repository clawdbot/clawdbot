import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type UsageLike,
} from "../agents/usage.js";
import type { SessionTranscriptUsageSnapshot } from "./session-utils.fs.js";

function extractSqliteUsageSnapshot(message: unknown): SessionTranscriptUsageSnapshot | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const record = message as {
    model?: unknown;
    provider?: unknown;
    usage?: unknown;
  };
  const usageRaw =
    record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
      ? (record.usage as UsageLike & { cost?: { total?: unknown }; costUsd?: unknown })
      : undefined;
  const usage = normalizeUsage(usageRaw);
  const normalizedUsage = usage ?? {};
  const totalTokens = deriveSessionTotalTokens({ usage });
  const modelProvider = typeof record.provider === "string" ? record.provider.trim() : undefined;
  const model = typeof record.model === "string" ? record.model.trim() : undefined;
  const costUsd =
    typeof usageRaw?.cost?.total === "number" && Number.isFinite(usageRaw.cost.total)
      ? usageRaw.cost.total
      : usageRaw?.costUsd;
  const hasMeaningfulUsage =
    hasNonzeroUsage(usage) ||
    typeof totalTokens === "number" ||
    (typeof costUsd === "number" && Number.isFinite(costUsd) && costUsd > 0);
  const isDeliveryMirror = modelProvider === "openclaw" && model === "delivery-mirror";
  if (!hasMeaningfulUsage && !modelProvider && !model) {
    return null;
  }
  if (isDeliveryMirror && !hasMeaningfulUsage) {
    return null;
  }
  return {
    ...(!isDeliveryMirror && modelProvider ? { modelProvider } : {}),
    ...(!isDeliveryMirror && model ? { model } : {}),
    ...(typeof normalizedUsage.input === "number" ? { inputTokens: normalizedUsage.input } : {}),
    ...(typeof normalizedUsage.output === "number" ? { outputTokens: normalizedUsage.output } : {}),
    ...(typeof normalizedUsage.cacheRead === "number"
      ? { cacheRead: normalizedUsage.cacheRead }
      : {}),
    ...(typeof normalizedUsage.cacheWrite === "number"
      ? { cacheWrite: normalizedUsage.cacheWrite }
      : {}),
    ...(typeof totalTokens === "number" ? { totalTokens, totalTokensFresh: true } : {}),
    ...(typeof costUsd === "number" && Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

export function aggregateSqliteUsageSnapshots(
  messages: unknown[],
): SessionTranscriptUsageSnapshot | null {
  const aggregate: SessionTranscriptUsageSnapshot = {};
  let sawUsage = false;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let costUsd = 0;
  let sawInput = false;
  let sawOutput = false;
  let sawCacheRead = false;
  let sawCacheWrite = false;
  let sawCost = false;
  for (const message of messages) {
    const snapshot = extractSqliteUsageSnapshot(message);
    if (!snapshot) {
      continue;
    }
    sawUsage = true;
    if (snapshot.modelProvider) {
      aggregate.modelProvider = snapshot.modelProvider;
    }
    if (snapshot.model) {
      aggregate.model = snapshot.model;
    }
    if (typeof snapshot.inputTokens === "number") {
      inputTokens += snapshot.inputTokens;
      sawInput = true;
    }
    if (typeof snapshot.outputTokens === "number") {
      outputTokens += snapshot.outputTokens;
      sawOutput = true;
    }
    if (typeof snapshot.cacheRead === "number") {
      cacheRead += snapshot.cacheRead;
      sawCacheRead = true;
    }
    if (typeof snapshot.cacheWrite === "number") {
      cacheWrite += snapshot.cacheWrite;
      sawCacheWrite = true;
    }
    if (typeof snapshot.totalTokens === "number") {
      aggregate.totalTokens = snapshot.totalTokens;
      aggregate.totalTokensFresh = true;
    }
    if (typeof snapshot.costUsd === "number") {
      costUsd += snapshot.costUsd;
      sawCost = true;
    }
  }
  if (!sawUsage) {
    return null;
  }
  if (sawInput) {
    aggregate.inputTokens = inputTokens;
  }
  if (sawOutput) {
    aggregate.outputTokens = outputTokens;
  }
  if (sawCacheRead) {
    aggregate.cacheRead = cacheRead;
  }
  if (sawCacheWrite) {
    aggregate.cacheWrite = cacheWrite;
  }
  if (sawCost) {
    aggregate.costUsd = costUsd;
  }
  return aggregate;
}

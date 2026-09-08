import {
  estimateStringChars,
  estimateTokensFromChars,
} from "@openclaw/normalization-core/cjk-chars";
import {
  asNonNegativeFiniteNumber,
  asPositiveFiniteNumber,
} from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  deriveSessionTotalTokens,
  hasNonzeroUsage,
  normalizeUsage,
  type ContextUsage,
  type UsageLike,
} from "../agents/usage.js";

export type SessionTranscriptUsageSnapshot = {
  modelProvider?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheRead?: number;
  cacheWrite?: number;
  contextUsage?: ContextUsage;
  trailingBytes?: number;
  totalTokens?: number;
  totalTokensFresh?: boolean;
  costUsd?: number;
};

type TranscriptUsageSource = "sqlite" | "artifact";

function extractTranscriptUsageSnapshot(
  message: unknown,
  source: TranscriptUsageSource,
): SessionTranscriptUsageSnapshot | null {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return null;
  }
  const record = message as {
    api?: unknown;
    model?: unknown;
    provider?: unknown;
    role?: unknown;
    usage?: unknown;
  };
  if (source === "artifact" && typeof record.role === "string" && record.role !== "assistant") {
    return null;
  }
  const usageRaw =
    record.usage && typeof record.usage === "object" && !Array.isArray(record.usage)
      ? (record.usage as UsageLike & { cost?: { total?: unknown }; costUsd?: unknown })
      : undefined;
  const usage = normalizeUsage(usageRaw);
  const normalizedUsage = usage ?? {};
  const api =
    source === "artifact" && typeof record.api === "string" ? record.api.trim() : record.api;
  const legacyCliUsage = api === "cli" && usageRaw && usageRaw.contextUsage === undefined;
  const derivedTotalTokens = legacyCliUsage ? undefined : deriveSessionTotalTokens({ usage });
  const totalTokens =
    source === "artifact" ? asPositiveFiniteNumber(derivedTotalTokens) : derivedTotalTokens;
  const modelProvider = typeof record.provider === "string" ? record.provider.trim() : undefined;
  const model = typeof record.model === "string" ? record.model.trim() : undefined;
  const costUsd =
    source === "artifact"
      ? asNonNegativeFiniteNumber(usageRaw?.cost?.total)
      : typeof usageRaw?.cost?.total === "number" && Number.isFinite(usageRaw.cost.total)
        ? usageRaw.cost.total
        : usageRaw?.costUsd;
  const hasMeaningfulUsage =
    hasNonzeroUsage(usage) ||
    typeof totalTokens === "number" ||
    (typeof costUsd === "number" &&
      Number.isFinite(costUsd) &&
      (source === "artifact" || costUsd > 0));
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
    ...(legacyCliUsage
      ? { contextUsage: { state: "unavailable" } as const }
      : normalizedUsage.contextUsage
        ? { contextUsage: normalizedUsage.contextUsage }
        : {}),
    ...(typeof totalTokens === "number" ? { totalTokens, totalTokensFresh: true } : {}),
    ...(typeof costUsd === "number" && Number.isFinite(costUsd) ? { costUsd } : {}),
  };
}

function estimateTranscriptMessageChars(message: unknown): number {
  if (!isRecord(message)) {
    return 0;
  }
  const content = message.content;
  if (typeof content === "string") {
    return content.trim() ? estimateStringChars(content.trim()) : 0;
  }
  if (!Array.isArray(content)) {
    return 0;
  }
  return content.reduce<number>((total, part) => {
    if (!isRecord(part)) {
      return total;
    }
    const { text, type } = part;
    if (
      typeof text !== "string" ||
      (typeof type === "string" &&
        type !== "text" &&
        type !== "output_text" &&
        type !== "input_text")
    ) {
      return total;
    }
    const normalized = text.trim();
    return normalized ? total + estimateStringChars(normalized) : total;
  }, 0);
}

export function aggregateSessionTranscriptUsage(
  messages: unknown[],
  source: TranscriptUsageSource = "sqlite",
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
  let estimatedTranscriptChars = 0;
  let sawEstimateModelIdentity = false;
  for (const message of messages) {
    if (source === "artifact" && isRecord(message)) {
      const provider = typeof message.provider === "string" ? message.provider.trim() : undefined;
      const model = typeof message.model === "string" ? message.model.trim() : undefined;
      if (
        (message.role === "user" || message.role === "assistant") &&
        !(message.role === "assistant" && provider === "openclaw" && model === "delivery-mirror")
      ) {
        const estimatedChars = estimateTranscriptMessageChars(message);
        estimatedTranscriptChars += estimatedChars;
        sawEstimateModelIdentity ||=
          message.role === "assistant" && estimatedChars > 0 && Boolean(provider || model);
      }
    }
    const snapshot = extractTranscriptUsageSnapshot(message, source);
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
    if (snapshot.contextUsage) {
      aggregate.contextUsage = snapshot.contextUsage;
    } else if (typeof snapshot.totalTokens === "number") {
      delete aggregate.contextUsage;
    }
    if (snapshot.contextUsage?.state === "unavailable") {
      // Match JSONL aggregation: the marker clears older context until a later
      // per-call snapshot replaces it during this forward scan.
      delete aggregate.totalTokens;
      delete aggregate.totalTokensFresh;
    } else if (typeof snapshot.totalTokens === "number") {
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
  if (
    source === "artifact" &&
    typeof aggregate.totalTokens !== "number" &&
    aggregate.contextUsage?.state !== "unavailable" &&
    estimatedTranscriptChars > 0 &&
    sawEstimateModelIdentity
  ) {
    const estimatedTotalTokens = estimateTokensFromChars(estimatedTranscriptChars);
    if (estimatedTotalTokens > 0) {
      aggregate.totalTokens = estimatedTotalTokens;
      aggregate.totalTokensFresh = true;
    }
  }
  return aggregate;
}

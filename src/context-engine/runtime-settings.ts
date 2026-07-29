import type { ContextEngineHostSupport } from "./host-compat.js";
import type {
  ContextEngineRuntimeReasonCode,
  ContextEngineSelectionSource,
  ContextEngineRuntimeMode,
  ContextEngineRuntimeSettings,
} from "./types.js";

type OptionalString = string | null | undefined;
type OptionalReason = string | null | undefined;

const RUNTIME_REASON_CODES = new Set<ContextEngineRuntimeReasonCode>([
  "provider_timeout",
  "provider_unavailable",
  "rate_limited",
  "context_overflow",
  "runtime_unavailable",
  "unknown",
]);

function normalizeNullableString(value: OptionalString): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function normalizeNullableNumber(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function normalizeReasonCode(value: OptionalReason): ContextEngineRuntimeReasonCode | null {
  const normalized = normalizeNullableString(value);
  if (!normalized) {
    return null;
  }
  if (RUNTIME_REASON_CODES.has(normalized as ContextEngineRuntimeReasonCode)) {
    return normalized as ContextEngineRuntimeReasonCode;
  }

  const lower = normalized.toLowerCase();
  if (lower.includes("timeout")) {
    return "provider_timeout";
  }
  if (lower.includes("rate") || lower.includes("limit") || lower.includes("429")) {
    return "rate_limited";
  }
  if (lower.includes("overflow") || lower.includes("context") || lower.includes("pressure")) {
    return "context_overflow";
  }
  if (lower.includes("runtime")) {
    return "runtime_unavailable";
  }
  if (lower.includes("provider") || lower.includes("primary") || lower.includes("unavailable")) {
    return "provider_unavailable";
  }
  return "unknown";
}

export function buildContextEngineRuntimeSettings(params: {
  mode?: ContextEngineRuntimeMode;
  harnessId?: OptionalString;
  runtimeId?: OptionalString;
  requestedModel?: OptionalString;
  resolvedModel?: OptionalString;
  provider?: OptionalString;
  modelFamily?: OptionalString;
  selectedContextEngineId?: OptionalString;
  contextEngineSelectionSource?: ContextEngineSelectionSource;
  fallbackReason?: OptionalReason;
  degradedReason?: OptionalReason;
  promptTokenBudget?: number | null;
  maxOutputTokens?: number | null;
  contextEngineHost: ContextEngineHostSupport;
}): ContextEngineRuntimeSettings {
  const hostId = normalizeNullableString(params.contextEngineHost.id);
  const selectedId = normalizeNullableString(params.selectedContextEngineId);
  const selectionSource =
    params.contextEngineSelectionSource ?? (selectedId ? "configured" : "unknown");

  const requestedModel = normalizeNullableString(params.requestedModel);
  const resolvedModel = normalizeNullableString(params.resolvedModel);
  const fallbackReason = normalizeReasonCode(params.fallbackReason);
  const degradedReason = normalizeReasonCode(params.degradedReason);
  const resolvedViaFallback =
    requestedModel !== null && resolvedModel !== null && requestedModel !== resolvedModel;
  const mode =
    params.mode ??
    (degradedReason ? "degraded" : fallbackReason || resolvedViaFallback ? "fallback" : "normal");

  return {
    schemaVersion: 1,
    runtime: {
      host: "openclaw",
      mode,
      harnessId: normalizeNullableString(params.harnessId),
      runtimeId: normalizeNullableString(params.runtimeId),
    },
    model: {
      requested: requestedModel,
      resolved: resolvedModel,
      provider: normalizeNullableString(params.provider),
      family: normalizeNullableString(params.modelFamily),
    },
    contextEngineSelection: {
      selectedId,
      source: selectionSource,
    },
    executionHost: {
      id: hostId,
      label: normalizeNullableString(params.contextEngineHost.label),
    },
    limits: {
      promptTokenBudget: normalizeNullableNumber(params.promptTokenBudget),
      maxOutputTokens: normalizeNullableNumber(params.maxOutputTokens),
    },
    diagnostics: {
      fallbackReason,
      degradedReason,
    },
  };
}

import { asFiniteNumber } from "@openclaw/normalization-core/number-coercion";
import { normalizeNullableString } from "@openclaw/normalization-core/string-coerce";
import type { ContextEngineHostSupport } from "./host-compat.js";
import type {
  ContextEngineRuntimeReasonCode,
  ContextEngineSelectionSource,
  ContextEngineRuntimeMode,
  ContextEngineRuntimeSettings,
} from "./types.js";

type OptionalString = string | null | undefined;

const RUNTIME_REASON_CODES = new Set<ContextEngineRuntimeReasonCode>([
  "provider_timeout",
  "provider_unavailable",
  "rate_limited",
  "context_overflow",
  "runtime_unavailable",
  "unknown",
]);
const RUNTIME_REASON_PATTERNS: Array<[ContextEngineRuntimeReasonCode, RegExp]> = [
  ["provider_timeout", /timeout/iu],
  ["rate_limited", /rate|limit|429/iu],
  ["context_overflow", /overflow|context|pressure/iu],
  ["runtime_unavailable", /runtime/iu],
  ["provider_unavailable", /provider|primary|unavailable/iu],
];

function normalizeReasonCode(value: OptionalString): ContextEngineRuntimeReasonCode | null {
  const normalized = normalizeNullableString(value);
  if (!normalized) {
    return null;
  }
  if (RUNTIME_REASON_CODES.has(normalized as ContextEngineRuntimeReasonCode)) {
    return normalized as ContextEngineRuntimeReasonCode;
  }

  return RUNTIME_REASON_PATTERNS.find(([, pattern]) => pattern.test(normalized))?.[0] ?? "unknown";
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
  fallbackReason?: OptionalString;
  degradedReason?: OptionalString;
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
      promptTokenBudget: asFiniteNumber(params.promptTokenBudget) ?? null,
      maxOutputTokens: asFiniteNumber(params.maxOutputTokens) ?? null,
    },
    diagnostics: {
      fallbackReason,
      degradedReason,
    },
  };
}

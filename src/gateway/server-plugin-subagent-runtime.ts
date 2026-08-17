import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  normalizeBuiltInProviderModelId,
  stripSelfProviderModelPrefix,
} from "@openclaw/model-catalog-core/provider-model-id-normalization";
import { normalizeModelRef } from "../agents/model-ref-shared.js";
import { parseModelRef } from "../agents/model-selection-normalize.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";

export function normalizePluginSubagentAllowedModelRef(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed === "*") {
    return "*";
  }
  const parsed = parseModelCatalogRef(trimmed);
  if (!parsed) {
    return null;
  }
  // Operator allowlists already name canonical targets; keep policy setup independent
  // of plugin metadata and provider-runtime discovery.
  const modelId = normalizeBuiltInProviderModelId(
    parsed.provider,
    stripSelfProviderModelPrefix(parsed.provider, parsed.modelId),
  );
  return `${parsed.provider}/${modelId}`;
}

export function resolvePluginSubagentRequestedModelRef(params: {
  provider?: string;
  model?: string;
}): string | null {
  if (params.provider && params.model) {
    const normalizedRequest = normalizeModelRef(params.provider, params.model);
    return `${normalizedRequest.provider}/${normalizedRequest.model}`;
  }
  const rawModel = params.model?.trim();
  if (!rawModel || !rawModel.includes("/")) {
    return null;
  }
  const parsed = parseModelRef(rawModel, "");
  if (!parsed?.provider || !parsed.model) {
    return null;
  }
  return `${parsed.provider}/${parsed.model}`;
}

export function normalizePluginSubagentRunRuntime(
  value: unknown,
): Awaited<ReturnType<PluginRuntime["subagent"]["run"]>>["runtime"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const harness = typeof record.harness === "string" ? record.harness.trim() : "";
  const provider = typeof record.provider === "string" ? record.provider.trim() : "";
  const model = typeof record.model === "string" ? record.model.trim() : "";
  return harness && provider && model ? { harness, provider, model } : undefined;
}

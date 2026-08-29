/**
 * Looks up model catalog entries and input capability support.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { isModelThinkingFormat, type ModelCompatConfig } from "../config/types.models.js";
import type { Model } from "../llm/types.js";
import type { ModelCatalogEntry, ModelInputType } from "./model-catalog.types.js";
import { modelTransportRoutesMatch } from "./model-compat-catalog.js";
import { canonicalizeProviderModelId } from "./provider-model-route.js";

type ModelThinkingCompat = {
  thinkingFormat?: ModelCompatConfig["thinkingFormat"];
  supportedReasoningEfforts?: readonly string[] | null;
};

export type PreparedModelThinkingCapability = Readonly<{
  provider: string;
  modelId: string;
  agentRuntime: string;
  /** Present only when the capability came from a physical provider route. */
  route?: Readonly<{ api: string; baseUrl: string }>;
  compat: ModelThinkingCompat;
}>;

/** Projects only thinking policy fields from broader model compatibility metadata. */
export function projectModelThinkingCompat(compat: unknown): ModelThinkingCompat | undefined {
  const record = asOptionalRecord(compat);
  if (!record) {
    return undefined;
  }
  const projected: ModelThinkingCompat = {};
  if (typeof record.thinkingFormat === "string" && isModelThinkingFormat(record.thinkingFormat)) {
    projected.thinkingFormat = record.thinkingFormat;
  }
  if (record.supportedReasoningEfforts === null) {
    projected.supportedReasoningEfforts = null;
  } else if (
    Array.isArray(record.supportedReasoningEfforts) &&
    record.supportedReasoningEfforts.every((effort) => typeof effort === "string")
  ) {
    projected.supportedReasoningEfforts = [...record.supportedReasoningEfforts];
  }
  return Object.keys(projected).length > 0 ? projected : undefined;
}

/** Freezes thinking capability from the selected prepared catalog row. */
function prepareModelThinkingCapability(params: {
  entry: ModelCatalogEntry | undefined;
  route?: Pick<ModelCatalogEntry, "api" | "baseUrl">;
  agentRuntime: string;
}): PreparedModelThinkingCapability | undefined {
  const compat = projectModelThinkingCompat(params.entry?.compat);
  const provider = normalizeProviderId(params.entry?.provider ?? "");
  const modelId = normalizeOptionalString(params.entry?.id);
  const agentRuntime = normalizeLowercaseStringOrEmpty(params.agentRuntime);
  if (!compat || !provider || !modelId || !agentRuntime) {
    return undefined;
  }
  const routeSource = params.route ?? (agentRuntime === "openclaw" ? params.entry : undefined);
  const api = normalizeOptionalString(routeSource?.api);
  const baseUrl = normalizeOptionalString(routeSource?.baseUrl);
  if (agentRuntime === "openclaw" && (!api || !baseUrl)) {
    return undefined;
  }
  return {
    provider,
    modelId,
    agentRuntime,
    ...(api && baseUrl ? { route: { api, baseUrl } } : {}),
    compat,
  };
}

/** Resolves prepared thinking metadata only for the exact final model route and harness. */
export function resolvePreparedModelThinkingCompat(params: {
  capability?: PreparedModelThinkingCapability;
  model: Pick<Model, "provider" | "id" | "api" | "baseUrl"> & {
    compat?: Model["compat"] | ModelThinkingCompat;
  };
  agentRuntime: string;
}): ModelThinkingCompat | undefined {
  const capability = params.capability;
  if (!capability) {
    return undefined;
  }
  const runtimeModelId = canonicalizeProviderModelId(capability.provider, params.model.id);
  const preparedModelId = canonicalizeProviderModelId(capability.provider, capability.modelId);
  if (
    normalizeProviderId(params.model.provider) !== capability.provider ||
    runtimeModelId !== preparedModelId ||
    normalizeLowercaseStringOrEmpty(params.agentRuntime) !== capability.agentRuntime ||
    (capability.route && !modelTransportRoutesMatch(params.model, capability.route))
  ) {
    return undefined;
  }
  const { compat, route } = capability;
  const efforts = compat.supportedReasoningEfforts;
  if (route || efforts === undefined) {
    return compat;
  }
  // "none" disables reasoning; it is not an enabled effort tier. Harness-wide
  // tiers may cross auth routes, but only the selected route can allow "none".
  const routeEfforts = projectModelThinkingCompat(params.model.compat)?.supportedReasoningEfforts;
  const enabledEfforts = efforts?.filter((effort) => effort !== "none");
  return {
    ...compat,
    supportedReasoningEfforts: routeEfforts?.includes("none")
      ? ["none", ...(enabledEfforts ?? [])]
      : (enabledEfforts ?? efforts),
  };
}

/** Projects the prepared capabilities needed by one selected run candidate. */
export function prepareModelRunCapabilities(
  [catalog, configuredCatalog]: readonly [ModelCatalogEntry[] | undefined, ModelCatalogEntry[]],
  [provider, modelId, agentRuntime]: readonly [string, string, string],
) {
  const entry = findModelInCatalog(catalog ?? [], provider, modelId);
  const configuredEntry = findModelInCatalog(configuredCatalog, provider, modelId);
  return {
    modelHasVision: modelSupportsInput(entry, "image"),
    modelThinkingCapability: prepareModelThinkingCapability({
      entry: entry ?? configuredEntry,
      route: agentRuntime === "openclaw" ? (configuredEntry ?? entry) : undefined,
      agentRuntime,
    }),
  };
}

/** Returns whether a catalog entry declares support for an input modality. */
export function modelSupportsInput(
  entry: ModelCatalogEntry | undefined,
  input: ModelInputType,
): boolean {
  return entry?.input?.includes(input) ?? false;
}

/** Finds a provider-qualified model entry in a catalog. */
export function findModelInCatalog(
  catalog: ModelCatalogEntry[],
  provider: string,
  modelId: string,
): ModelCatalogEntry | undefined {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  return catalog.find(
    (entry) =>
      normalizeProviderId(entry.provider) === normalizedProvider &&
      normalizeLowercaseStringOrEmpty(entry.id) === normalizedModelId,
  );
}

/** Finds a model entry, requiring uniqueness when provider is omitted. */
export function findModelCatalogEntry(
  catalog: ModelCatalogEntry[],
  params: { provider?: string; modelId: string },
): ModelCatalogEntry | undefined {
  const modelId = normalizeOptionalString(params.modelId) ?? "";
  if (!modelId) {
    return undefined;
  }

  const provider = normalizeOptionalString(params.provider);
  if (provider) {
    return findModelInCatalog(catalog, provider, modelId);
  }

  const normalizedModelId = normalizeLowercaseStringOrEmpty(modelId);
  const matches = catalog.filter(
    (entry) => normalizeLowercaseStringOrEmpty(entry.id) === normalizedModelId,
  );
  return matches.length === 1 ? matches[0] : undefined;
}

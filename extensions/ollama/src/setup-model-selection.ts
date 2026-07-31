import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { OLLAMA_CLOUD_DEFAULT_MODELS } from "./defaults.js";
import {
  buildDefaultOllamaCloudModelDefinition,
  buildOllamaModelDefinition,
  enrichOllamaModelsWithContext,
  fetchOllamaModels,
  readOllamaModelShowInfo,
  resolveOllamaApiBase,
  type OllamaModelWithContext,
} from "./provider-models.js";

const OLLAMA_CONTEXT_ENRICH_LIMIT = 200;
const OLLAMA_TOOLS_SCAN_CONCURRENCY = 8;

type OllamaCloudDefaultModel = (typeof OLLAMA_CLOUD_DEFAULT_MODELS)[number];

export function normalizeOllamaModelName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed.toLowerCase().startsWith("ollama/")
    ? trimmed.slice("ollama/".length).trim() || undefined
    : trimmed;
}

function getOllamaLatestDedupeKey(name: string): string {
  const normalized = name.trim().toLowerCase();
  return normalized.endsWith(":latest") ? normalized.slice(0, -":latest".length) : normalized;
}

export function mergeUniqueModelNames(...groups: string[][]): string[] {
  const mergedByKey = new Map<string, string>();
  for (const group of groups) {
    for (const name of group) {
      const key = getOllamaLatestDedupeKey(name);
      const existing = mergedByKey.get(key);
      if (
        existing === undefined ||
        (!existing.trim().toLowerCase().endsWith(":latest") &&
          name.trim().toLowerCase().endsWith(":latest"))
      ) {
        mergedByKey.set(key, name);
      }
    }
  }
  return [...mergedByKey.values()];
}

export function findAvailableOllamaModelName(
  modelName: string,
  availableModelNames: Iterable<string>,
): string | undefined {
  const wantedKey = getOllamaLatestDedupeKey(modelName);
  for (const available of availableModelNames) {
    if (getOllamaLatestDedupeKey(available) === wantedKey) {
      return available;
    }
  }
  return undefined;
}

export function buildOllamaModelsConfig(
  modelNames: string[],
  discoveredModelsByName?: Map<string, OllamaModelWithContext>,
  defaultModels: readonly OllamaCloudDefaultModel[] = [],
) {
  return modelNames.map((name) => {
    const discovered = discoveredModelsByName?.get(name);
    const defaultModel = defaultModels.find((model) => model.id === name);
    if (defaultModel && !discovered) {
      return buildDefaultOllamaCloudModelDefinition(defaultModel);
    }
    const capabilities =
      discovered?.capabilities ?? (defaultModel ? [...defaultModel.capabilities] : undefined);
    return buildOllamaModelDefinition(
      name,
      discovered?.contextWindow ?? defaultModel?.contextWindow,
      capabilities,
      { showInspectionFailed: discovered?.showInspectionFailed },
    );
  });
}

export async function inspectOllamaModelsForSetup(
  baseUrl: string,
  models: OllamaModelWithContext[],
  signal?: AbortSignal,
): Promise<{ inspected: OllamaModelWithContext[]; inspectionFailures: string[] }> {
  const apiBase = resolveOllamaApiBase(baseUrl);
  const inspected: OllamaModelWithContext[] = [];
  const inspectionFailures: string[] = [];
  for (let index = 0; index < models.length; index += OLLAMA_TOOLS_SCAN_CONCURRENCY) {
    signal?.throwIfAborted();
    const batch = models.slice(index, index + OLLAMA_TOOLS_SCAN_CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (model) => {
        try {
          const showInfo = await readOllamaModelShowInfo(apiBase, model.name, {
            timeoutMs: 3000,
            signal,
            auditContext: "ollama-setup.tools-scan",
          });
          return Object.assign({}, model, showInfo);
        } catch (error) {
          signal?.throwIfAborted();
          // A failed inspection must not inherit the optimistic tools default
          // reserved for models that were never inspected. Keep the failure
          // distinct from authoritative empty capabilities so name-based
          // reasoning detection still applies.
          inspectionFailures.push(`${model.name}: ${formatErrorMessage(error)}`);
          return Object.assign({}, model, { showInspectionFailed: true as const });
        }
      }),
    );
    inspected.push(...results);
  }
  return { inspected, inspectionFailures };
}

export async function discoverOllamaModelsForSetup(params: {
  baseUrl: string;
  inspectTools?: boolean;
  signal?: AbortSignal;
}) {
  const { reachable, models } = await fetchOllamaModels(params.baseUrl);
  const firstModels = models.slice(0, OLLAMA_CONTEXT_ENRICH_LIMIT);
  const inspection: { inspected: OllamaModelWithContext[]; inspectionFailures: string[] } =
    !reachable
      ? { inspected: [], inspectionFailures: [] }
      : params.inspectTools
        ? await inspectOllamaModelsForSetup(params.baseUrl, firstModels, params.signal)
        : {
            inspected: await enrichOllamaModelsWithContext(params.baseUrl, firstModels),
            inspectionFailures: [],
          };
  if (
    params.inspectTools &&
    !inspection.inspected.some((model) => model.capabilities?.includes("tools")) &&
    models.length > OLLAMA_CONTEXT_ENRICH_LIMIT
  ) {
    const remainingScan = await inspectOllamaModelsForSetup(
      params.baseUrl,
      models.slice(OLLAMA_CONTEXT_ENRICH_LIMIT),
      params.signal,
    );
    inspection.inspected.push(...remainingScan.inspected);
    inspection.inspectionFailures.push(...remainingScan.inspectionFailures);
  }
  return {
    reachable,
    models,
    inspectedModels: inspection.inspected,
    discoveredModelsByName: new Map(inspection.inspected.map((model) => [model.name, model])),
    inspectionFailures: inspection.inspectionFailures,
    hasToolsCapableModel: inspection.inspected.some((model) =>
      model.capabilities?.includes("tools"),
    ),
  };
}

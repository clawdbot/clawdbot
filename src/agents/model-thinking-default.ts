/**
 * Resolves default thinking levels for provider/model pairs. It combines
 * explicit per-model config, global defaults, catalog metadata, and model
 * family fallbacks.
 */
import type { ThinkLevel } from "../auto-reply/thinking.shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogEntry } from "./model-catalog.types.js";
import { buildConfiguredModelCatalog } from "./model-selection-shared.js";
import {
  resolveConfiguredThinkingDefaultCore,
  resolveThinkingDefaultCore,
} from "./model-thinking-default-core.js";

/** Resolves configured thinking without consulting model capability metadata. */
export function resolveConfiguredThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
}): ThinkLevel | undefined {
  return resolveConfiguredThinkingDefaultCore(params);
}

/** Resolves the default thinking level for a provider/model pair. */
export function resolveThinkingDefault(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  catalog?: ModelCatalogEntry[];
  agentRuntime?: string | null;
}): ThinkLevel {
  return resolveThinkingDefaultCore(params);
}

/** Resolves thinking default after loading runtime catalog only when needed. */
export async function resolveThinkingDefaultWithRuntimeCatalogCore(params: {
  cfg: OpenClawConfig;
  provider: string;
  model: string;
  loadRuntimeCatalog: () => Promise<ModelCatalogEntry[]>;
  agentRuntime?: string | null;
}): Promise<ThinkLevel> {
  const configuredCatalog = buildConfiguredModelCatalog({ cfg: params.cfg });
  const configuredSelectedEntry = configuredCatalog.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const needsRuntimeCatalog =
    configuredCatalog.length === 0 ||
    !configuredSelectedEntry ||
    configuredSelectedEntry.reasoning === undefined;
  const runtimeCatalog = needsRuntimeCatalog ? await params.loadRuntimeCatalog() : undefined;
  const runtimeSelectedEntry = runtimeCatalog?.find(
    (entry) => entry.provider === params.provider && entry.id === params.model,
  );
  const catalog =
    runtimeSelectedEntry || configuredCatalog.length === 0
      ? (runtimeCatalog ?? configuredCatalog)
      : configuredCatalog;
  return resolveThinkingDefault({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    catalog,
    agentRuntime: params.agentRuntime,
  });
}

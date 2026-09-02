/** Prepared plugin metadata handoff for runtime model normalization. */
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  findNormalizedProviderKey,
  modelKey,
  normalizeModelRef,
  normalizeProviderId,
} from "../../agents/model-selection.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getCurrentPluginMetadataSnapshot } from "../../plugins/current-plugin-metadata-snapshot.js";
import {
  isManifestPluginAvailableForControlPlane,
  loadManifestMetadataSnapshot,
} from "../../plugins/manifest-contract-eligibility.js";
import { resolveModelRuntimeDirective } from "./directive-handling.model-runtime.js";

export type RuntimeModelNormalization = NonNullable<Parameters<typeof normalizeModelRef>[2]>;

/** Carries the Gateway-owned metadata snapshot through one model-selection run. */
export function resolveRuntimeNormalization(cfg: OpenClawConfig): RuntimeModelNormalization {
  return {
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    manifestPlugins: getCurrentPluginMetadataSnapshot({
      config: cfg,
      allowWorkspaceScopedSnapshot: true,
    }),
  };
}

export function normalizeRuntimeRef(
  provider: string,
  model: string,
  normalization: RuntimeModelNormalization = RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
) {
  return normalizeModelRef(provider, model, normalization);
}

export function findSelectedCatalogEntry(params: {
  catalog?: readonly ModelCatalogEntry[];
  provider: string;
  model: string;
}): ModelCatalogEntry | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  const selectedKey = modelKey(normalizedProvider, params.model);
  return params.catalog?.find((entry) => modelKey(entry.provider, entry.id) === selectedKey);
}

/** Provider identity comes from authored routes or prepared/plugin metadata, not model inventory. */
export function isKnownModelSelectionProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  catalog: readonly ModelCatalogEntry[];
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (
    findNormalizedProviderKey(params.cfg.models?.providers, provider) ||
    params.catalog.some((entry) => normalizeProviderId(entry.provider) === provider)
  ) {
    return true;
  }
  const snapshot = loadManifestMetadataSnapshot({ config: params.cfg });
  return snapshot.plugins.some(
    (plugin) =>
      plugin.providers.some((id) => normalizeProviderId(id) === provider) &&
      isManifestPluginAvailableForControlPlane({ snapshot, plugin, config: params.cfg }),
  );
}

type ModelSelectionPreparation =
  | {
      status: "ready";
      catalog: ModelCatalogEntry[];
      runtime: Exclude<ReturnType<typeof resolveModelRuntimeDirective>, { kind: "invalid" }>;
    }
  | { status: "rejected"; reason: "invalid-runtime" | "unknown-provider"; message: string };

/** Prepare runtime and capabilities for the selected route before any session mutation. */
export async function prepareModelSelectionRuntime(params: {
  cfg: OpenClawConfig;
  agentId: string;
  provider: string;
  model: string;
  catalog: readonly ModelCatalogEntry[];
  rawRuntime?: string;
  sessionEntry?: Pick<SessionEntry, "agentRuntimeOverride">;
}): Promise<ModelSelectionPreparation> {
  const runtime = resolveModelRuntimeDirective(params);
  if (runtime.kind === "invalid") {
    return { status: "rejected", reason: "invalid-runtime", message: runtime.errorText };
  }
  const selected = findSelectedCatalogEntry(params);
  if (!isKnownModelSelectionProvider(params)) {
    return {
      status: "rejected",
      reason: "unknown-provider",
      message: `Unknown provider "${params.provider}". Use /models to list providers.`,
    };
  }
  if (selected?.reasoning !== undefined) {
    return { status: "ready", runtime, catalog: [...params.catalog] };
  }
  // The selected route owns its capabilities. A prepared default-provider row cannot
  // supply thinking or context metadata for an explicit cross-provider selection.
  const { loadProviderScopedThinkingCatalog } =
    await import("../../agents/model-catalog.runtime.js");
  const catalog = await loadProviderScopedThinkingCatalog({
    config: params.cfg,
    agentId: params.agentId,
    provider: params.provider,
    model: params.model,
  });
  const resolved = findSelectedCatalogEntry({ ...params, catalog });
  return {
    status: "ready",
    runtime,
    catalog: resolved
      ? [resolved, ...params.catalog.filter((entry) => entry !== selected)]
      : [...params.catalog],
  };
}

export function mergePreparedConfiguredCatalog(params: {
  configured: ModelCatalogEntry[];
  prepared?: readonly ModelCatalogEntry[];
}): ModelCatalogEntry[] {
  if (!params.prepared?.length) {
    return params.configured;
  }
  const preparedByKey = new Map(
    params.prepared.map((entry) => [modelKey(entry.provider, entry.id), entry]),
  );
  return params.configured.map((entry) => {
    const prepared = preparedByKey.get(modelKey(entry.provider, entry.id));
    // The prepared row owns runtime capabilities; the configured row limits
    // visibility and retains any authored metadata absent from that snapshot.
    return prepared ? { ...entry, ...prepared } : entry;
  });
}

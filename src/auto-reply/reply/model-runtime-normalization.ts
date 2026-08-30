/** Prepared plugin metadata handoff for runtime model normalization. */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import {
  findNormalizedProviderKey,
  normalizeProviderId,
  type ModelRef,
  type normalizeModelRef,
} from "../../agents/model-ref-shared.js";
import {
  createModelManifestPluginContext,
  type ModelManifestPluginContext,
} from "../../agents/model-selection-shared.js";
import { RUNTIME_MODEL_VISIBILITY_NORMALIZATION } from "../../agents/model-visibility-policy.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isManifestPluginAvailableForControlPlane } from "../../plugins/manifest-contract-eligibility.js";
import { resolveModelRuntimeDirective } from "./directive-handling.model-runtime.js";

/** A producing branch owns either the selected ref or its deferred preparation. */
export type PreparedReplyModelRef = ModelRef | (() => ModelRef);

export function resolvePreparedReplyModelRef(ref: PreparedReplyModelRef): ModelRef {
  return typeof ref === "function" ? ref() : ref;
}

export type RuntimeModelNormalization = NonNullable<Parameters<typeof normalizeModelRef>[2]> & {
  manifestPluginContext?: ModelManifestPluginContext;
};

/** Carries the Gateway-owned metadata snapshot through one model-selection run. */
export function resolveRuntimeNormalization(
  cfg: OpenClawConfig,
  agentId?: string,
  params?: { workspaceDir?: string; manifestPluginContext?: ModelManifestPluginContext },
): RuntimeModelNormalization {
  const manifestPluginContext =
    params?.manifestPluginContext ??
    createModelManifestPluginContext({ cfg, agentId, workspaceDir: params?.workspaceDir });
  return {
    ...RUNTIME_MODEL_VISIBILITY_NORMALIZATION,
    ...manifestPluginContext.getContext(),
    manifestPluginContext,
  };
}

export function findSelectedCatalogEntry(params: {
  catalog?: readonly ModelCatalogEntry[];
  provider: string;
  model: string;
}): ModelCatalogEntry | undefined {
  const selectedKey = buildModelCatalogRef(params.provider, params.model);
  return params.catalog?.find(
    (entry) => buildModelCatalogRef(entry.provider, entry.id) === selectedKey,
  );
}

/** Provider identity comes from authored routes or prepared/plugin metadata, not model inventory. */
export function isKnownModelSelectionProvider(params: {
  cfg: OpenClawConfig;
  provider: string;
  catalog: readonly ModelCatalogEntry[];
  agentId?: string;
  workspaceDir?: string;
  manifestPluginContext?: ModelManifestPluginContext;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (
    findNormalizedProviderKey(params.cfg.models?.providers, provider) ||
    params.catalog.some((entry) => normalizeProviderId(entry.provider) === provider)
  ) {
    return true;
  }
  const context = params.manifestPluginContext ?? createModelManifestPluginContext(params);
  const snapshot = context.getContext().pluginMetadataSnapshot;
  // Provider eligibility belongs to this operation's captured graph, including
  // an intentionally empty retained generation. Never reopen global discovery.
  return (
    snapshot?.manifestRegistry.plugins.some(
      (plugin) =>
        plugin.providers.some((id) => normalizeProviderId(id) === provider) &&
        isManifestPluginAvailableForControlPlane({ snapshot, plugin, config: params.cfg }),
    ) ?? false
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
  agentDir?: string;
  workspaceDir?: string;
  manifestPluginContext?: ModelManifestPluginContext;
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
  const manifestPluginContext =
    params.manifestPluginContext ?? createModelManifestPluginContext(params);
  if (!isKnownModelSelectionProvider({ ...params, manifestPluginContext })) {
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
  const { workspaceDir } = manifestPluginContext.getContext();
  const catalog = await loadProviderScopedThinkingCatalog({
    config: params.cfg,
    agentId: params.agentId,
    ...(params.agentDir ? { agentDir: params.agentDir } : {}),
    ...(workspaceDir ? { workspaceDir } : {}),
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
    params.prepared.map((entry) => [buildModelCatalogRef(entry.provider, entry.id), entry]),
  );
  return params.configured.map((entry) => {
    const prepared = preparedByKey.get(buildModelCatalogRef(entry.provider, entry.id));
    // The prepared row owns runtime capabilities; the configured row limits
    // visibility and retains any authored metadata absent from that snapshot.
    return prepared ? { ...entry, ...prepared } : entry;
  });
}

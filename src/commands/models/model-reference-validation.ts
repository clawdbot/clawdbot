import { buildModelCatalogMergeKey } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveConfiguredModelEntries } from "../../agents/configured-model-entries.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { planEffectiveModelCatalogRows } from "../../model-catalog/index.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";

type ModelReferenceInspection = {
  ref: string;
  provider: string;
  model: string;
  status: "known" | "unknown-model" | "unknown-provider";
};

type ModelReferenceInspectionParams = {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  metadataSnapshot?: PluginMetadataSnapshot;
  workspaceDir?: string;
};

function createModelReferenceInspector(params: ModelReferenceInspectionParams) {
  const snapshot =
    params.metadataSnapshot ??
    loadManifestMetadataSnapshot({
      config: params.cfg,
      env: params.env ?? process.env,
      ...(params.workspaceDir ? { workspaceDir: params.workspaceDir } : {}),
    });
  const knownProviders = new Set(
    [
      ...snapshot.owners.providers.keys(),
      ...snapshot.owners.modelCatalogProviders.keys(),
      ...snapshot.owners.cliBackends.keys(),
      ...Object.keys(params.cfg.models?.providers ?? {}),
    ]
      .map(normalizeProviderId)
      .filter(Boolean),
  );
  const knownModels = new Set(
    planEffectiveModelCatalogRows({
      registry: snapshot.manifestRegistry,
      config: params.cfg,
    }).rows.map((row) => row.mergeKey),
  );
  for (const [provider, providerConfig] of Object.entries(params.cfg.models?.providers ?? {})) {
    for (const model of providerConfig.models ?? []) {
      knownModels.add(buildModelCatalogMergeKey(provider, model.id));
    }
  }
  const inspect = (candidate: { provider: string; model: string }): ModelReferenceInspection => {
    const provider = normalizeProviderId(candidate.provider);
    const model = candidate.model.trim();
    const ref = `${provider}/${model}`;
    if (!knownProviders.has(provider)) {
      return { ref, provider, model, status: "unknown-provider" };
    }
    const status = knownModels.has(buildModelCatalogMergeKey(provider, model))
      ? "known"
      : "unknown-model";
    return { ref, provider, model, status };
  };
  return { inspect, snapshot };
}

/** Classifies a resolved model ref without loading provider runtimes or making network calls. */
export function inspectModelReference(
  params: ModelReferenceInspectionParams & { ref: { provider: string; model: string } },
): ModelReferenceInspection {
  return createModelReferenceInspector(params).inspect(params.ref);
}

/** Inspects every default/fallback/image/configured model entry for Doctor. */
export function inspectConfiguredModelReferences(
  params: ModelReferenceInspectionParams,
): Array<ModelReferenceInspection & { active: boolean }> {
  const { inspect, snapshot } = createModelReferenceInspector(params);
  // `inspect` returns a fresh object per call, so tagging it in place avoids a
  // per-entry spread copy without sharing state between entries.
  const canonicalizer = createModelCatalogProviderAliasCanonicalizer({
    cfg: params.cfg,
    metadataSnapshot: snapshot,
  });
  return resolveConfiguredModelEntries({
    cfg: params.cfg,
    allowPluginNormalization: false,
    canonicalizeRef: canonicalizer.ref,
  }).entries.map((entry) =>
    Object.assign(inspect(entry.ref), {
      active: [...entry.tags].some((tag) => tag !== "configured"),
    }),
  );
}

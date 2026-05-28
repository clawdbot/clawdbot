import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { Model } from "../../llm/types.js";
import { planManifestModelCatalogRows } from "../../model-catalog/manifest-planner.js";
import type { NormalizedModelCatalogRow } from "../../model-catalog/types.js";
import { listOpenClawPluginManifestMetadata } from "../../plugins/manifest-metadata-scan.js";
import { loadPluginManifestRegistry } from "../../plugins/manifest-registry.js";
import type { PluginManifestRecord } from "../../plugins/manifest-registry.js";
import { loadPluginManifest } from "../../plugins/manifest.js";
import { normalizeStaticProviderModelId } from "../model-ref-shared.js";
import { normalizeProviderId } from "../provider-id.js";

function rowMatchesModel(params: {
  row: NormalizedModelCatalogRow;
  provider: string;
  modelId: string;
}): boolean {
  const normalizedProvider = normalizeProviderId(params.provider);
  if (normalizeProviderId(params.row.provider) !== normalizedProvider) {
    return false;
  }
  return (
    normalizeStaticProviderModelId(normalizedProvider, params.row.id).trim().toLowerCase() ===
    normalizeStaticProviderModelId(normalizedProvider, params.modelId).trim().toLowerCase()
  );
}

function modelFromStaticCatalogRow(row: NormalizedModelCatalogRow): Model {
  return {
    id: row.id,
    name: row.name || row.id,
    provider: row.provider,
    api: row.api ?? "openai-responses",
    baseUrl: row.baseUrl,
    reasoning: row.reasoning,
    input: row.input,
    cost: row.cost,
    contextWindow: row.contextWindow,
    contextTokens: row.contextTokens,
    maxTokens: row.maxTokens,
    headers: row.headers,
    compat: row.compat,
    mediaInput: row.mediaInput,
  } as Model;
}

type StaticCatalogPlugin = Parameters<
  typeof planManifestModelCatalogRows
>[0]["registry"]["plugins"][number];

function listBundledStaticCatalogPlugins(env: NodeJS.ProcessEnv): StaticCatalogPlugin[] {
  return listOpenClawPluginManifestMetadata(env).flatMap((record): StaticCatalogPlugin[] => {
    if (record.origin !== "bundled") {
      return [];
    }
    const loaded = loadPluginManifest(record.pluginDir);
    if (!loaded.ok || !loaded.manifest.modelCatalog) {
      return [];
    }
    return [
      {
        id: loaded.manifest.id,
        providers: loaded.manifest.providers,
        modelCatalog: loaded.manifest.modelCatalog,
      },
    ];
  });
}

function resolveManifestModelCatalogProviderAlias(params: {
  provider: string;
  plugins: readonly Pick<PluginManifestRecord, "providers" | "modelCatalog">[];
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return undefined;
  }
  const targets = new Set<string>();
  for (const plugin of params.plugins) {
    for (const [rawAlias, alias] of Object.entries(plugin.modelCatalog?.aliases ?? {})) {
      const normalizedAlias = normalizeProviderId(rawAlias);
      const normalizedTarget = normalizeProviderId(alias.provider);
      if (
        normalizedAlias === provider &&
        normalizedTarget &&
        plugin.providers.some((providerId) => normalizeProviderId(providerId) === normalizedTarget)
      ) {
        targets.add(normalizedTarget);
      }
    }
  }
  return targets.size === 1 ? [...targets][0] : undefined;
}

export function canonicalizeManifestModelCatalogProviderAlias(params: {
  provider: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return params.provider;
  }
  return (
    resolveManifestModelCatalogProviderAlias({
      provider,
      plugins: loadPluginManifestRegistry({
        config: params.cfg,
        workspaceDir: params.workspaceDir,
        env: params.env ?? process.env,
      }).plugins,
    }) ?? params.provider
  );
}

export function bundledStaticCatalogProviderUsesRuntimeAugment(params: {
  provider: string;
  env?: NodeJS.ProcessEnv;
}): boolean {
  const provider = normalizeProviderId(params.provider);
  if (!provider) {
    return false;
  }
  return listBundledStaticCatalogPlugins(params.env ?? process.env).some((plugin) => {
    const catalog = plugin.modelCatalog;
    if (catalog?.runtimeAugment !== true) {
      return false;
    }
    return (
      Object.keys(catalog.providers ?? {}).some(
        (candidate) => normalizeProviderId(candidate) === provider,
      ) ||
      Object.keys(catalog.aliases ?? {}).some(
        (candidate) => normalizeProviderId(candidate) === provider,
      )
    );
  });
}

export function resolveBundledStaticCatalogModel(params: {
  provider: string;
  modelId: string;
  cfg?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Model | undefined {
  const provider = normalizeProviderId(params.provider);
  if (!provider || !params.modelId.trim()) {
    return undefined;
  }
  const bundledStaticPlugins = listBundledStaticCatalogPlugins(params.env ?? process.env);
  if (bundledStaticPlugins.length === 0) {
    return undefined;
  }
  const plan = planManifestModelCatalogRows({
    registry: { plugins: bundledStaticPlugins },
    providerFilter: provider,
  });
  for (const entry of plan.entries) {
    if (entry.discovery !== "static") {
      continue;
    }
    const row = entry.rows.find((candidate) =>
      rowMatchesModel({
        row: candidate,
        provider,
        modelId: params.modelId,
      }),
    );
    if (row) {
      return modelFromStaticCatalogRow(row);
    }
  }
  return undefined;
}

/** Provider alias canonicalization for model catalog rows. */
import fs from "node:fs";
import path from "node:path";
import { normalizeProviderId } from "../../agents/model-selection.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  loadPluginManifestRegistry,
  type PluginManifestRecord,
} from "../../plugins/manifest-registry.js";
import { loadPluginManifest, type PluginManifestModelCatalog } from "../../plugins/manifest.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";

type ProviderAliasSource = {
  cfg: OpenClawConfig;
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">;
};

const sourcePeerModelCatalogCache = new Map<string, PluginManifestModelCatalog | null>();

function listManifestPlugins(params: ProviderAliasSource): readonly PluginManifestRecord[] {
  return (
    params.metadataSnapshot?.manifestRegistry.plugins ??
    loadPluginManifestRegistry({
      config: params.cfg,
    }).plugins
  );
}

function resolveSourcePeerPluginRoot(
  plugin: Pick<PluginManifestRecord, "id" | "origin" | "rootDir">,
): string | undefined {
  if (plugin.origin !== "bundled") {
    return undefined;
  }
  const parts = path.resolve(plugin.rootDir).split(path.sep);
  const pluginDirName = parts.at(-1);
  const extensionsDirName = parts.at(-2);
  const buildDirName = parts.at(-3);
  if (
    pluginDirName !== plugin.id ||
    extensionsDirName !== "extensions" ||
    (buildDirName !== "dist" && buildDirName !== "dist-runtime")
  ) {
    return undefined;
  }
  const packageRoot = parts.slice(0, -3).join(path.sep) || path.sep;
  const sourceRoot = path.join(packageRoot, "extensions", plugin.id);
  return fs.existsSync(path.join(sourceRoot, "openclaw.plugin.json")) ? sourceRoot : undefined;
}

function loadSourcePeerModelCatalog(
  plugin: Pick<PluginManifestRecord, "id" | "origin" | "rootDir">,
): PluginManifestModelCatalog | undefined {
  const cacheKey = path.resolve(plugin.rootDir);
  const cached = sourcePeerModelCatalogCache.get(cacheKey);
  if (cached !== undefined) {
    return cached ?? undefined;
  }
  const sourceRoot = resolveSourcePeerPluginRoot(plugin);
  if (!sourceRoot) {
    sourcePeerModelCatalogCache.set(cacheKey, null);
    return undefined;
  }
  // Bundled dist manifests can omit source-only alias metadata during local
  // development; read the peer source manifest to keep list output canonical.
  const loaded = loadPluginManifest(sourceRoot, false);
  if (!loaded.ok || loaded.manifest.id !== plugin.id) {
    sourcePeerModelCatalogCache.set(cacheKey, null);
    return undefined;
  }
  const modelCatalog = loaded.manifest.modelCatalog ?? null;
  sourcePeerModelCatalogCache.set(cacheKey, modelCatalog);
  return modelCatalog ?? undefined;
}

function hasModelCatalogAliases(modelCatalog: PluginManifestModelCatalog | undefined): boolean {
  return Object.keys(modelCatalog?.aliases ?? {}).length > 0;
}

function collectModelCatalogAliases(
  aliases: Map<string, string>,
  modelCatalog: PluginManifestModelCatalog | undefined,
): void {
  for (const [aliasProvider, target] of Object.entries(modelCatalog?.aliases ?? {})) {
    const alias = normalizeProviderId(aliasProvider);
    const provider = normalizeProviderId(target.provider);
    if (alias && provider) {
      aliases.set(alias, provider);
    }
  }
}

function buildProviderAliasMap(params: ProviderAliasSource): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const plugin of listManifestPlugins(params)) {
    collectModelCatalogAliases(aliases, plugin.modelCatalog);
    if (!hasModelCatalogAliases(plugin.modelCatalog) && plugin.origin === "bundled") {
      collectModelCatalogAliases(aliases, loadSourcePeerModelCatalog(plugin));
    }
  }
  return aliases;
}

/** Builds provider/ref canonicalizers from manifest model-catalog aliases. */
export function createModelCatalogProviderAliasCanonicalizer(params: ProviderAliasSource): {
  provider: (provider: string) => string;
  ref: <TRef extends { provider: string }>(ref: TRef) => TRef;
} {
  const aliases = buildProviderAliasMap(params);
  const provider = (providerId: string) => {
    const normalizedProvider = normalizeProviderId(providerId);
    return aliases.get(normalizedProvider) ?? normalizedProvider;
  };
  return {
    provider,
    ref: (ref) => {
      const canonicalProvider = provider(ref.provider);
      return canonicalProvider === ref.provider ? ref : { ...ref, provider: canonicalProvider };
    },
  };
}

/** Canonicalizes a provider id through manifest model-catalog aliases. */
export function canonicalizeModelCatalogProviderAlias(
  provider: string,
  params: ProviderAliasSource,
): string {
  return createModelCatalogProviderAliasCanonicalizer(params).provider(provider);
}

/** Canonicalizes the provider field on a model reference. */
export function canonicalizeModelCatalogProviderRef<TRef extends { provider: string }>(
  ref: TRef,
  params: ProviderAliasSource,
): TRef {
  return createModelCatalogProviderAliasCanonicalizer(params).ref(ref);
}

import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import {
  listOfficialExternalPluginCatalogEntries,
  getOfficialExternalPluginCatalogManifest,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginInstallSources,
  type OfficialExternalPluginCatalogEntry,
  loadConfiguredHostedOfficialExternalPluginCatalogEntries,
} from "./official-external-plugin-catalog.js";
import { getPluginCache, type PluginCache } from "./plugin-cache.js";

/** Prepare once at the control-plane boundary; runtime readers never fetch. */
export async function loadOfficialPluginCatalogSnapshot(params?: { env?: NodeJS.ProcessEnv }) {
  const cache = getPluginCache();
  if (!cache.officialCatalog) {
    const snapshot: NonNullable<PluginCache["officialCatalog"]> = {
      pending: Promise.resolve()
        .then(() => loadConfiguredHostedOfficialExternalPluginCatalogEntries(params))
        .then((result) => ({
          ...result,
          entries: overlayBundledOfficialPluginCatalogMetadata(result.entries, undefined, {
            hostedFeaturedAuthoritative: result.source !== "bundled-fallback",
          }),
        })),
    };
    cache.officialCatalog = snapshot;
    void snapshot.pending.then(
      (result) => {
        snapshot.result = result;
      },
      () => {
        if (cache.officialCatalog === snapshot) {
          cache.officialCatalog = undefined;
        }
      },
    );
  }
  return await cache.officialCatalog.pending;
}

export function getOfficialPluginCatalogSnapshot() {
  // The bundled catalog remains the shipped offline/cold-start contract.
  return (
    getPluginCache().officialCatalog?.result ?? {
      source: "bundled-fallback" as const,
      entries: listOfficialExternalPluginCatalogEntries(),
    }
  );
}

export function resolveCatalogManifestIcon(manifest: unknown): string | undefined {
  if (!manifest || typeof manifest !== "object") {
    return undefined;
  }
  // SAFETY: The object guard permits property access; normalization still validates the unknown icon.
  return normalizeOptionalString((manifest as { icon?: unknown }).icon);
}

function mergeCatalogMetadata(
  hosted: OfficialExternalPluginCatalogEntry,
  bundled: OfficialExternalPluginCatalogEntry,
  options: { hostedFeaturedAuthoritative: boolean },
): OfficialExternalPluginCatalogEntry {
  const hostedManifest = getOfficialExternalPluginCatalogManifest(hosted);
  const bundledManifest = getOfficialExternalPluginCatalogManifest(bundled);
  const bundledCatalog = bundledManifest?.catalog;
  const bundledPlugin = bundledManifest?.plugin;
  const bundledIcon = resolveCatalogManifestIcon(bundledManifest);
  const bundledName = normalizeOptionalString(bundled.name);
  const bundledDescription = normalizeOptionalString(bundled.description);
  const bundledKind = normalizeOptionalString(bundled.kind);
  const bundledSource = normalizeOptionalString(bundled.source);
  const hostedFeatured = typeof hosted.featured === "boolean" ? hosted.featured : false;
  const mergedCatalog =
    bundledCatalog ||
    hostedManifest?.catalog ||
    (options.hostedFeaturedAuthoritative && hostedFeatured)
      ? {
          ...hostedManifest?.catalog,
          ...bundledCatalog,
          ...(options.hostedFeaturedAuthoritative ? { featured: hostedFeatured } : {}),
        }
      : undefined;
  if (!mergedCatalog && !bundledPlugin) {
    return hosted;
  }
  return {
    ...hosted,
    ...(!normalizeOptionalString(hosted.name) && bundledName ? { name: bundledName } : {}),
    ...(!normalizeOptionalString(hosted.description) && bundledDescription
      ? { description: bundledDescription }
      : {}),
    ...(!normalizeOptionalString(hosted.kind) && bundledKind ? { kind: bundledKind } : {}),
    ...(!normalizeOptionalString(hosted.source) && bundledSource ? { source: bundledSource } : {}),
    [MANIFEST_KEY]: {
      ...hostedManifest,
      ...(hostedManifest?.providers === undefined && bundledManifest?.providers
        ? { providers: bundledManifest.providers }
        : {}),
      ...(bundledPlugin ? { plugin: { ...hostedManifest?.plugin, ...bundledPlugin } } : {}),
      ...(mergedCatalog ? { catalog: mergedCatalog } : {}),
      ...(!resolveCatalogManifestIcon(hostedManifest) && bundledIcon ? { icon: bundledIcon } : {}),
    },
  };
}

export function prepareCatalogEntry(entry: OfficialExternalPluginCatalogEntry) {
  const install = resolveOfficialExternalPluginInstall(entry);
  const sources = resolveOfficialExternalPluginInstallSources(entry, { resolvedInstall: install });
  const clawhubSpec = sources.find((source) => source.source === "clawhub")?.spec;
  const npmSpec = sources.find((source) => source.source === "npm")?.spec;
  return {
    entry,
    install,
    selectedSource: sources[0],
    clawhub: clawhubSpec ? parseClawHubPluginSpec(clawhubSpec) : undefined,
    npmPackage: npmSpec ? parseRegistryNpmSpec(npmSpec)?.name : undefined,
  };
}

/**
 * Overlay local runtime identity and ordering after an exact package/source match.
 * Hosted curation wins; bundled Featured state survives only in fallback mode.
 */
function overlayBundledOfficialPluginCatalogMetadata(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  bundledEntries: readonly OfficialExternalPluginCatalogEntry[] = listOfficialExternalPluginCatalogEntries(),
  options: { hostedFeaturedAuthoritative: boolean } = {
    hostedFeaturedAuthoritative: false,
  },
): OfficialExternalPluginCatalogEntry[] {
  const bundledFacts = entries.length > 0 ? bundledEntries.map(prepareCatalogEntry) : [];
  return entries.map((entry) => {
    const { clawhub, npmPackage } = prepareCatalogEntry(entry);
    const matches = bundledFacts.filter(
      (bundled) =>
        (clawhub && bundled.clawhub?.name === clawhub.name) ||
        (npmPackage && bundled.npmPackage === npmPackage),
    );
    const bundled = matches.length === 1 ? matches[0]?.entry : undefined;
    if (bundled) {
      return mergeCatalogMetadata(entry, bundled, options);
    }
    if (!options.hostedFeaturedAuthoritative) {
      return entry;
    }
    const hostedManifest = getOfficialExternalPluginCatalogManifest(entry);
    if (entry.featured !== true && !hostedManifest?.catalog) {
      return entry;
    }
    return {
      ...entry,
      [MANIFEST_KEY]: {
        ...hostedManifest,
        catalog: {
          ...hostedManifest?.catalog,
          featured: entry.featured === true,
        },
      },
    };
  });
}

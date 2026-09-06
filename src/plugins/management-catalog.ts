// Prepares presentation-only catalog facts and owns their metadata-scoped cache.
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  PluginCatalogEntry,
  PluginsListResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  resolveTrustedOfficialClawHubPackageName,
  resolveTrustedSourceLinkedOfficialClawHubSpec,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  loadConfiguredHostedOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginInstallSources,
  type HostedOfficialExternalPluginCatalogLoadResult,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";
import {
  getPluginCache,
  getPluginMetadataSnapshotCache,
  getProcessPluginCache,
  getScopedPluginCache,
  withPluginCache,
} from "./plugin-cache.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";

export type ManagedPluginCatalogEntry = PluginCatalogEntry;
export type ManagedPluginCatalog = PluginsListResult;

export type OfficialCatalogResult = Pick<
  HostedOfficialExternalPluginCatalogLoadResult,
  "entries"
> & {
  error?: string;
  hostedFeaturedAuthoritative?: boolean;
};

export function getManagedPluginCache(metadata?: PluginMetadataSnapshot) {
  if (metadata) {
    return getPluginMetadataSnapshotCache(metadata);
  }
  const scoped = getScopedPluginCache();
  if (scoped?.kind === "operation") {
    return scoped;
  }
  const candidate = getProcessPluginCache().desiredMetadata;
  if (candidate && candidate.boot === getProcessGatewayPluginMetadataSnapshot()) {
    return candidate.cache;
  }
  return getPluginCache();
}

export function withManagedPluginCache<
  TParams extends { config: OpenClawConfig; metadata?: PluginMetadataSnapshot },
  TResult,
>(run: (params: TParams) => Promise<TResult>): (params: TParams) => Promise<TResult> {
  return (params) => withPluginCache(getManagedPluginCache(params.metadata), () => run(params));
}

/** Clear the process-stable hosted catalog snapshot after an explicit owner reload. */
export function clearManagedPluginOfficialCatalogCache(): void {
  getManagedPluginCache().officialCatalog = undefined;
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
      ...(bundledPlugin ? { plugin: { ...hostedManifest?.plugin, ...bundledPlugin } } : {}),
      ...(mergedCatalog ? { catalog: mergedCatalog } : {}),
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

type PreparedCatalogEntry = ReturnType<typeof prepareCatalogEntry>;

export function prepareCatalogEntries(entries: readonly OfficialExternalPluginCatalogEntry[]) {
  let prepared: PreparedCatalogEntry[] | undefined;
  // Unknown local installs never need package identities from the official catalog.
  // Resolve each collection only when provenance admits a lookup, then reuse its facts.
  return () => (prepared ??= entries.map(prepareCatalogEntry));
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

export async function loadOfficialCatalog(): Promise<OfficialCatalogResult> {
  const cache = getManagedPluginCache();
  if (!cache.officialCatalog) {
    const promise = Promise.resolve().then(() =>
      loadConfiguredHostedOfficialExternalPluginCatalogEntries(),
    );
    cache.officialCatalog = promise;
    void promise.catch(() => {
      if (cache.officialCatalog === promise) {
        cache.officialCatalog = undefined;
      }
    });
  }
  const result = await cache.officialCatalog;
  const hostedFeaturedAuthoritative =
    result.source === "hosted" || result.source === "hosted-snapshot";
  return {
    entries: overlayBundledOfficialPluginCatalogMetadata(result.entries, undefined, {
      hostedFeaturedAuthoritative,
    }),
    hostedFeaturedAuthoritative,
    ...("error" in result ? { error: result.error } : {}),
  };
}

export function normalizeKinds(kind: string | readonly string[] | undefined): string[] | undefined {
  const values = (typeof kind === "string" ? [kind] : (kind ?? []))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

export function normalizeCatalogMetadata(
  value: unknown,
): { featured?: boolean; order?: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const featured = typeof value.featured === "boolean" ? value.featured : undefined;
  const order =
    typeof value.order === "number" && Number.isFinite(value.order) ? value.order : undefined;
  return featured === undefined && order === undefined
    ? undefined
    : {
        ...(featured !== undefined ? { featured } : {}),
        ...(order !== undefined ? { order } : {}),
      };
}

export function normalizeFeaturedAt(value: unknown): number | undefined {
  return asSafeIntegerInRange(value, { min: 0 });
}

/** Coarse manifest-derived grouping so catalog UIs can shelve a large inventory. */
export function derivePluginCategory(
  manifest: PluginManifestRecord | undefined,
): string | undefined {
  if (!manifest) {
    return undefined;
  }
  if (manifest.channels.length > 0 || Object.keys(manifest.channelConfigs ?? {}).length > 0) {
    return "channel";
  }
  const mediaProvider =
    Object.keys(manifest.imageGenerationProviderMetadata ?? {}).length > 0 ||
    Object.keys(manifest.videoGenerationProviderMetadata ?? {}).length > 0 ||
    Object.keys(manifest.musicGenerationProviderMetadata ?? {}).length > 0 ||
    Object.keys(manifest.mediaUnderstandingProviderMetadata ?? {}).length > 0;
  if (
    manifest.providers.length > 0 ||
    manifest.providerEndpoints?.length ||
    manifest.modelCatalog ||
    mediaProvider
  ) {
    return "provider";
  }
  const kinds = normalizeKinds(manifest.kind);
  if (kinds?.includes("memory")) {
    return "memory";
  }
  if (kinds?.includes("context-engine")) {
    return "context-engine";
  }
  if (
    manifest.contracts?.tools?.length ||
    Object.keys(manifest.toolMetadata ?? {}).length > 0 ||
    manifest.skills.length > 0
  ) {
    return "tool";
  }
  return undefined;
}

export function firstPluginError(
  diagnostics: readonly PluginDiagnostic[],
  pluginId: string,
): string | undefined {
  return diagnostics.find(
    (diagnostic) => diagnostic.level === "error" && diagnostic.pluginId === pluginId,
  )?.message;
}

export function compareCatalogEntries(
  left: ManagedPluginCatalogEntry,
  right: ManagedPluginCatalogEntry,
): number {
  const featured = Number(Boolean(right.featured)) - Number(Boolean(left.featured));
  if (featured !== 0) {
    return featured;
  }
  if (left.featured && right.featured) {
    const leftFeaturedAt = left.featuredAt;
    const rightFeaturedAt = right.featuredAt;
    if (leftFeaturedAt !== undefined || rightFeaturedAt !== undefined) {
      if (leftFeaturedAt === undefined) {
        return 1;
      }
      if (rightFeaturedAt === undefined) {
        return -1;
      }
      if (leftFeaturedAt !== rightFeaturedAt) {
        return rightFeaturedAt - leftFeaturedAt;
      }
    }
  }
  const order = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER);
  return order !== 0 ? order : left.name.localeCompare(right.name);
}

function resolveInstalledOfficialCatalogEntry(params: {
  entries: ReturnType<typeof prepareCatalogEntries>;
  packageName?: string;
  source: "clawhub" | "npm";
}): PreparedCatalogEntry | undefined {
  if (!params.packageName) {
    return undefined;
  }
  const matches = params
    .entries()
    .filter(
      ({ clawhub, npmPackage }) =>
        (params.source === "clawhub" ? clawhub?.name : npmPackage) === params.packageName,
    );
  return matches.length === 1 ? matches[0] : undefined;
}

type PluginIndexRecord = PluginMetadataSnapshot["index"]["plugins"][number];

export function resolveInstalledPluginPresentation(params: {
  record: PluginIndexRecord;
  manifest?: PluginManifestRecord;
  officialEntry?: OfficialExternalPluginCatalogEntry;
  hostedListingAuthoritative: boolean;
}): Pick<ManagedPluginCatalogEntry, "name" | "description" | "version"> {
  const { record, manifest, officialEntry, hostedListingAuthoritative } = params;
  // Registry names may be backfilled with npm specifiers, which are not display labels.
  const manifestName = manifest?.name !== record.packageName ? manifest?.name : undefined;
  const localName = manifestName ?? manifest?.channelCatalogMeta?.label ?? record.pluginId;
  const localDescription =
    manifest?.description ?? manifest?.channelCatalogMeta?.blurb ?? manifest?.packageDescription;
  const name =
    (hostedListingAuthoritative ? normalizeOptionalString(officialEntry?.title) : undefined) ??
    localName;
  const description =
    (hostedListingAuthoritative
      ? normalizeOptionalString(officialEntry?.description)
      : undefined) ?? localDescription;
  const version = record.packageVersion ?? manifest?.version;
  return {
    name,
    ...(description ? { description } : {}),
    ...(version ? { version } : {}),
  };
}

export function resolveInstalledHostedOfficialEntry(params: {
  record: PluginIndexRecord;
  installOwner?: string;
  installRecord?: PluginInstallRecord;
  officialEntries: ReturnType<typeof prepareCatalogEntries>;
  bundledOfficialEntries: ReturnType<typeof prepareCatalogEntries>;
}): {
  entry?: OfficialExternalPluginCatalogEntry;
  clawhubPackage?: string;
} {
  const identityPluginId = params.installOwner ?? params.record.pluginId;
  const trustedOfficialClawHubSpec = params.installRecord
    ? resolveTrustedSourceLinkedOfficialClawHubSpec({
        pluginId: identityPluginId,
        record: params.installRecord,
      })
    : undefined;
  const trustedOfficialNpmSpec = params.installRecord
    ? resolveTrustedSourceLinkedOfficialNpmSpec({
        pluginId: identityPluginId,
        record: params.installRecord,
      })
    : undefined;
  const sourceLinkedOfficialClawHubPackage = trustedOfficialClawHubSpec
    ? parseClawHubPluginSpec(trustedOfficialClawHubSpec)?.name
    : undefined;
  const currentOfficialClawHubPackage = params.installRecord
    ? resolveTrustedOfficialClawHubPackageName(params.installRecord)
    : undefined;
  const trustedOfficialNpmPackage = trustedOfficialNpmSpec
    ? parseRegistryNpmSpec(trustedOfficialNpmSpec)?.name
    : undefined;
  const bundledPublishedEntry =
    params.record.origin === "bundled"
      ? resolveInstalledOfficialCatalogEntry({
          entries: params.bundledOfficialEntries,
          packageName: params.record.packageName,
          source: "npm",
        })
      : undefined;
  const installedOfficialIdentity = sourceLinkedOfficialClawHubPackage
    ? { source: "clawhub" as const, packageName: sourceLinkedOfficialClawHubPackage }
    : trustedOfficialNpmPackage
      ? { source: "npm" as const, packageName: trustedOfficialNpmPackage }
      : currentOfficialClawHubPackage &&
          (!params.record.packageName ||
            params.record.packageName === currentOfficialClawHubPackage)
        ? { source: "clawhub" as const, packageName: currentOfficialClawHubPackage }
        : bundledPublishedEntry && params.record.packageName
          ? { source: "npm" as const, packageName: params.record.packageName }
          : undefined;
  const hasInstalledOfficialProvenance = Boolean(
    installedOfficialIdentity &&
    (!params.record.packageName ||
      params.record.packageName === installedOfficialIdentity.packageName),
  );
  const bundledOfficialEntry =
    bundledPublishedEntry ??
    resolveInstalledOfficialCatalogEntry({
      entries: params.bundledOfficialEntries,
      packageName: hasInstalledOfficialProvenance
        ? installedOfficialIdentity?.packageName
        : undefined,
      source: installedOfficialIdentity?.source ?? "clawhub",
    });
  const hostedPackageName =
    installedOfficialIdentity?.source === "npm"
      ? bundledOfficialEntry?.clawhub?.name
      : installedOfficialIdentity?.packageName;
  return {
    entry: resolveInstalledOfficialCatalogEntry({
      entries: params.officialEntries,
      packageName: hasInstalledOfficialProvenance ? hostedPackageName : undefined,
      source: "clawhub",
    })?.entry,
    clawhubPackage: hasInstalledOfficialProvenance ? hostedPackageName : undefined,
  };
}

export function resolveOfficialEntryById(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  pluginId: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) => resolveOfficialExternalPluginId(entry) === pluginId);
}

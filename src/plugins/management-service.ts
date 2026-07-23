// Structured plugin catalog and lifecycle operations shared by Gateway-facing surfaces.
import path from "node:path";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { collectChangedPaths } from "../config/io.write-prepare.js";
import { resolveIsNixMode } from "../config/paths.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { formatErrorMessage } from "../infra/errors.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import type { RuntimeEnv } from "../runtime.js";
import { CLAWHUB_INSTALL_ERROR_CODE } from "./clawhub-error-codes.js";
import { buildClawHubPluginInstallRecordFields } from "./clawhub-install-records.js";
import { installPluginFromClawHub } from "./clawhub.js";
import { enableExplicitlySelectedPluginInConfig } from "./enable.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  persistPluginInstall,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import { installPluginFromNpmSpec } from "./install.js";
import {
  loadInstalledPluginIndexInstallRecords,
  removePluginInstallRecordFromRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { buildNpmResolutionInstallFields } from "./installs.js";
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
  resolveOfficialExternalPluginLabel,
  type HostedOfficialExternalPluginCatalogLoadResult,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { loadPluginMetadataSnapshot } from "./plugin-metadata-snapshot.js";
import { resolveManifestProviderAuthChoices } from "./provider-auth-choices.js";
import { listRecommendedToolInstalls } from "./recommended-tool-installs.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";
import { collectClawPluginUninstallWarnings } from "./uninstall-claw-references.js";
import {
  applyPluginUninstallDirectoryRemoval,
  formatUninstallActionLabels,
  planPluginUninstall,
  pluginUninstallTargetExists,
  prepareConfigForPendingPluginDirectoryRemoval,
} from "./uninstall.js";

type ManagedPluginCatalogEntry = {
  id: string;
  name: string;
  packageName?: string;
  description?: string;
  version?: string;
  kind?: string[];
  origin?: string;
  installed: boolean;
  enabled: boolean;
  state: "enabled" | "disabled" | "not-installed" | "error";
  featured?: boolean;
  featuredAt?: number;
  order?: number;
  hasIcon?: boolean;
  install?: { source: "clawhub"; packageName: string } | { source: "official"; pluginId: string };
  error?: string;
  category?: string;
  removable?: boolean;
};

type ManagedPluginCatalog = {
  plugins: ManagedPluginCatalogEntry[];
  diagnostics: unknown[];
  mutationAllowed: boolean;
};

type ManagedPluginInstallRequest =
  | {
      source: "clawhub";
      packageName: string;
      version?: string;
      acknowledgeClawHubRisk?: boolean;
    }
  | { source: "official"; pluginId: string };

export class ManagedPluginLifecycleError extends Error {
  readonly kind: "invalid-request" | "unavailable";
  readonly code?: string;
  readonly version?: string;
  readonly warning?: string;

  constructor(
    message: string,
    details?: {
      kind?: "invalid-request" | "unavailable";
      code?: string;
      version?: string;
      warning?: string;
      cause?: unknown;
    },
  ) {
    super(message, details?.cause !== undefined ? { cause: details.cause } : undefined);
    this.name = "ManagedPluginLifecycleError";
    this.kind = details?.kind ?? "invalid-request";
    this.code = details?.code;
    this.version = details?.version;
    this.warning = details?.warning;
  }
}

type OfficialCatalogResult = Pick<HostedOfficialExternalPluginCatalogLoadResult, "entries"> & {
  error?: string;
  hostedFeaturedAuthoritative?: boolean;
};

let officialCatalogCache:
  | { key: string; result: Promise<HostedOfficialExternalPluginCatalogLoadResult> }
  | undefined;

const OFFICIAL_CATALOG_CACHE_KEY = "built-in";

/** Clear the process-stable hosted catalog snapshot after an explicit owner reload. */
export function clearManagedPluginOfficialCatalogCache(): void {
  officialCatalogCache = undefined;
}

function resolveCatalogManifestIcon(manifest: unknown): string | undefined {
  if (!manifest || typeof manifest !== "object") {
    return undefined;
  }
  return normalizeOptionalString((manifest as { icon?: unknown }).icon);
}

function resolveCatalogEntryIcon(entry: OfficialExternalPluginCatalogEntry | undefined) {
  return (
    normalizeOptionalString(entry?.icon) ??
    resolveCatalogManifestIcon(getOfficialExternalPluginCatalogManifest(entry ?? {}))
  );
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
      ...(bundledPlugin ? { plugin: { ...hostedManifest?.plugin, ...bundledPlugin } } : {}),
      ...(mergedCatalog ? { catalog: mergedCatalog } : {}),
      ...(!resolveCatalogManifestIcon(hostedManifest) && bundledIcon ? { icon: bundledIcon } : {}),
    },
  };
}

type CatalogPackageSourceIdentity = {
  source: "clawhub" | "npm";
  packageName: string;
};

function resolveCatalogPackageSourceIdentities(
  entry: OfficialExternalPluginCatalogEntry,
): CatalogPackageSourceIdentity[] {
  const install = resolveOfficialExternalPluginInstall(entry);
  const clawhubPackage = install?.clawhubSpec
    ? parseClawHubPluginSpec(install.clawhubSpec)?.name
    : undefined;
  const npmPackage = install?.npmSpec ? parseRegistryNpmSpec(install.npmSpec)?.name : undefined;
  return [
    ...(clawhubPackage ? [{ source: "clawhub" as const, packageName: clawhubPackage }] : []),
    ...(npmPackage ? [{ source: "npm" as const, packageName: npmPackage }] : []),
  ];
}

function matchesBundledCatalogIdentity(params: {
  hosted: OfficialExternalPluginCatalogEntry;
  bundled: OfficialExternalPluginCatalogEntry;
}): boolean {
  const hostedSources = resolveCatalogPackageSourceIdentities(params.hosted);
  const bundledSources = resolveCatalogPackageSourceIdentities(params.bundled);
  return hostedSources.some((hosted) =>
    bundledSources.some(
      (bundled) => bundled.source === hosted.source && bundled.packageName === hosted.packageName,
    ),
  );
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
  return entries.map((entry) => {
    const matches = bundledEntries.filter((bundled) =>
      matchesBundledCatalogIdentity({ hosted: entry, bundled }),
    );
    const bundled = matches.length === 1 ? matches[0] : undefined;
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

async function loadOfficialCatalog(): Promise<OfficialCatalogResult> {
  const key = OFFICIAL_CATALOG_CACHE_KEY;
  if (officialCatalogCache?.key !== key) {
    officialCatalogCache = {
      key,
      result: loadConfiguredHostedOfficialExternalPluginCatalogEntries(),
    };
  }
  const result = await officialCatalogCache.result;
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

function normalizeKinds(kind: string | readonly string[] | undefined): string[] | undefined {
  const values = (typeof kind === "string" ? [kind] : (kind ?? []))
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length > 0 ? [...new Set(values)] : undefined;
}

function normalizeCatalogMetadata(
  value: unknown,
): { featured?: boolean; order?: number } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const featured = typeof record.featured === "boolean" ? record.featured : undefined;
  const order =
    typeof record.order === "number" && Number.isFinite(record.order) ? record.order : undefined;
  return featured === undefined && order === undefined
    ? undefined
    : {
        ...(featured !== undefined ? { featured } : {}),
        ...(order !== undefined ? { order } : {}),
      };
}

function normalizeFeaturedAt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function resolveCatalogInstallAction(params: {
  entry: OfficialExternalPluginCatalogEntry;
  pluginId: string;
}): ManagedPluginCatalogEntry["install"] {
  const install = resolveOfficialExternalPluginInstall(params.entry);
  const clawhub = install?.clawhubSpec ? parseClawHubPluginSpec(install.clawhubSpec) : undefined;
  if (clawhub && !clawhub.version) {
    return { source: "clawhub", packageName: clawhub.name };
  }
  return install ? { source: "official", pluginId: params.pluginId } : undefined;
}

/** Coarse manifest-derived grouping so catalog UIs can shelve a large inventory. */
function derivePluginCategory(manifest: PluginManifestRecord | undefined): string | undefined {
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

function firstPluginError(
  diagnostics: readonly PluginDiagnostic[],
  pluginId: string,
): string | undefined {
  return diagnostics.find(
    (diagnostic) => diagnostic.level === "error" && diagnostic.pluginId === pluginId,
  )?.message;
}

function compareCatalogEntries(
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
  entries: readonly OfficialExternalPluginCatalogEntry[];
  packageName?: string;
  source: CatalogPackageSourceIdentity["source"];
}): OfficialExternalPluginCatalogEntry | undefined {
  if (!params.packageName) {
    return undefined;
  }
  const matches = params.entries.filter((entry) =>
    resolveCatalogPackageSourceIdentities(entry).some(
      (identity) =>
        identity.source === params.source && identity.packageName === params.packageName,
    ),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

function resolveOfficialCatalogIconUrl(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  pluginId: string,
): string | undefined {
  const entry = entries.find(
    (candidate) => resolveOfficialExternalPluginId(candidate) === pluginId,
  );
  return resolveCatalogEntryIcon(entry);
}

type PluginMetadataSnapshot = ReturnType<typeof loadPluginMetadataSnapshot>;
type PluginIndexRecord = PluginMetadataSnapshot["index"]["plugins"][number];

function resolveInstalledHostedOfficialEntry(params: {
  record: PluginIndexRecord;
  installRecord?: PluginInstallRecord;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  bundledOfficialEntries: readonly OfficialExternalPluginCatalogEntry[];
}): {
  entry?: OfficialExternalPluginCatalogEntry;
  hasPublishedIdentity: boolean;
} {
  const trustedOfficialClawHubSpec = params.installRecord
    ? resolveTrustedSourceLinkedOfficialClawHubSpec({
        pluginId: params.record.pluginId,
        record: params.installRecord,
      })
    : undefined;
  const trustedOfficialNpmSpec = params.installRecord
    ? resolveTrustedSourceLinkedOfficialNpmSpec({
        pluginId: params.record.pluginId,
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
      ? (bundledOfficialEntry
          ? resolveCatalogPackageSourceIdentities(bundledOfficialEntry)
          : []
        ).find((identity) => identity.source === "clawhub")?.packageName
      : installedOfficialIdentity?.packageName;
  return {
    entry: resolveInstalledOfficialCatalogEntry({
      entries: params.officialEntries,
      packageName: hasInstalledOfficialProvenance ? hostedPackageName : undefined,
      source: "clawhub",
    }),
    hasPublishedIdentity: Boolean(hasInstalledOfficialProvenance && hostedPackageName),
  };
}

function resolvePluginIconUrlFromCatalogFacts(params: {
  metadata: PluginMetadataSnapshot;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  bundledOfficialEntries?: readonly OfficialExternalPluginCatalogEntry[];
  pluginId: string;
}): string | undefined {
  const normalizedPluginId = params.metadata.normalizePluginId(params.pluginId);
  const record = params.metadata.index.plugins.find(
    (candidate) => params.metadata.normalizePluginId(candidate.pluginId) === normalizedPluginId,
  );
  const localIcon = normalizeOptionalString(
    params.metadata.byPluginId.get(normalizedPluginId)?.icon,
  );
  if (!record) {
    return resolveOfficialCatalogIconUrl(params.officialEntries, normalizedPluginId);
  }
  const { entry: officialEntry } = resolveInstalledHostedOfficialEntry({
    record,
    installRecord: params.metadata.index.installRecords[record.pluginId],
    officialEntries: params.officialEntries,
    bundledOfficialEntries:
      params.bundledOfficialEntries ?? listOfficialExternalPluginCatalogEntries(),
  });
  return resolveCatalogEntryIcon(officialEntry) ?? localIcon;
}

/** Resolve the current manifest/catalog icon URL without accepting a caller-provided URL. */
export async function resolveManagedPluginIconUrl(params: {
  config: OpenClawConfig;
  pluginId: string;
  env?: NodeJS.ProcessEnv;
  officialCatalog?: OfficialCatalogResult;
}): Promise<string | undefined> {
  const env = params.env ?? process.env;
  const metadata = loadPluginMetadataSnapshot({ config: params.config, env });
  const officialCatalog = params.officialCatalog ?? (await loadOfficialCatalog());
  return resolvePluginIconUrlFromCatalogFacts({
    metadata,
    officialEntries: officialCatalog.entries,
    bundledOfficialEntries: listOfficialExternalPluginCatalogEntries(),
    pluginId: params.pluginId,
  });
}

function normalizeManagedCatalogIconUrl(value: unknown): string | undefined {
  const normalized = normalizeOptionalString(value);
  if (!normalized || normalized.length > 2048) {
    return undefined;
  }
  try {
    const url = new URL(normalized);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password && !url.hash
      ? url.href
      : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve only URLs currently owned by a manifest or bundled presentation catalog. */
export function resolveManagedSetupCatalogIconUrl(params: {
  config: OpenClawConfig;
  iconUrl: string;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const requested = normalizeManagedCatalogIconUrl(params.iconUrl);
  if (!requested) {
    return undefined;
  }
  const env = params.env ?? process.env;
  const allowedUrls = [
    ...resolveManifestProviderAuthChoices({
      config: params.config,
      env,
      includeUntrustedWorkspacePlugins: false,
      includeWorkspacePlugins: false,
    }).map((choice) => choice.icon),
    ...listRecommendedToolInstalls().map((install) => install.icon),
  ];
  return allowedUrls.some((iconUrl) => normalizeManagedCatalogIconUrl(iconUrl) === requested)
    ? requested
    : undefined;
}

/** Build cold installed state merged with the hosted official catalog and bundled curation. */
export async function listManagedPlugins(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  officialCatalog?: OfficialCatalogResult;
}): Promise<ManagedPluginCatalog> {
  const env = params.env ?? process.env;
  const metadata = loadPluginMetadataSnapshot({ config: params.config, env });
  const officialCatalog = params.officialCatalog ?? (await loadOfficialCatalog());
  const bundledOfficialEntries = listOfficialExternalPluginCatalogEntries();
  const plugins = metadata.index.plugins.map((record): ManagedPluginCatalogEntry => {
    const manifest = metadata.byPluginId.get(record.pluginId);
    const localCatalog = normalizeCatalogMetadata(manifest?.catalog);
    const installRecord = metadata.index.installRecords[record.pluginId];
    const { entry: officialEntry, hasPublishedIdentity } = resolveInstalledHostedOfficialEntry({
      record,
      installRecord,
      officialEntries: officialCatalog.entries,
      bundledOfficialEntries,
    });
    const hasHostedOfficialIdentity = hasPublishedIdentity;
    const officialCatalogMetadata = officialEntry
      ? normalizeCatalogMetadata(getOfficialExternalPluginCatalogManifest(officialEntry)?.catalog)
      : undefined;
    // Published plugin curation follows the live feed even after install, including
    // omission. Private bundled plugins without an exact package/source match stay local.
    const catalog =
      hasHostedOfficialIdentity && officialCatalog.hostedFeaturedAuthoritative
        ? {
            ...localCatalog,
            ...officialCatalogMetadata,
            featured: officialEntry?.featured === true,
          }
        : officialCatalogMetadata
          ? { ...localCatalog, ...officialCatalogMetadata }
          : localCatalog;
    const error = firstPluginError(metadata.diagnostics, record.pluginId);
    const kind = normalizeKinds(manifest?.kind);
    const category = derivePluginCategory(manifest);
    // Only externally installed plugins (tracked install record, non-bundled) can be removed.
    const removable =
      record.origin !== "bundled" && Boolean(metadata.index.installRecords[record.pluginId]);
    // Prefer human labels over package specifiers: the registry backfills a
    // missing manifest name with the npm package name, which is an install
    // spec rather than a display name.
    const manifestName =
      manifest?.name && manifest.name !== record.packageName ? manifest.name : undefined;
    const localName = manifestName ?? manifest?.channelCatalogMeta?.label ?? record.pluginId;
    const localDescription =
      manifest?.description ?? manifest?.channelCatalogMeta?.blurb ?? manifest?.packageDescription;
    const hostedListingAuthoritative =
      hasHostedOfficialIdentity && officialCatalog.hostedFeaturedAuthoritative;
    const featuredAt =
      hostedListingAuthoritative && catalog?.featured === true
        ? normalizeFeaturedAt(officialEntry?.featuredAt)
        : undefined;
    const name =
      (hostedListingAuthoritative ? normalizeOptionalString(officialEntry?.title) : undefined) ??
      localName;
    const description =
      (hostedListingAuthoritative
        ? normalizeOptionalString(officialEntry?.description)
        : undefined) ?? localDescription;
    return {
      id: record.pluginId,
      name,
      ...(record.packageName ? { packageName: record.packageName } : {}),
      ...(description ? { description } : {}),
      ...(record.packageVersion || manifest?.version
        ? { version: record.packageVersion ?? manifest?.version }
        : {}),
      ...(kind ? { kind } : {}),
      ...(record.origin ? { origin: record.origin } : {}),
      installed: true,
      enabled: record.enabled,
      state: error ? "error" : record.enabled ? "enabled" : "disabled",
      ...(catalog?.featured !== undefined ? { featured: catalog.featured } : {}),
      ...(featuredAt !== undefined ? { featuredAt } : {}),
      ...(catalog?.order !== undefined ? { order: catalog.order } : {}),
      ...(resolvePluginIconUrlFromCatalogFacts({
        metadata,
        officialEntries: officialCatalog.entries,
        bundledOfficialEntries,
        pluginId: record.pluginId,
      })
        ? { hasIcon: true }
        : {}),
      ...(error ? { error } : {}),
      ...(category ? { category } : {}),
      removable,
    };
  });
  const installedIds = new Set(plugins.map((plugin) => plugin.id));
  const installedPackageNames = new Set(
    plugins.flatMap((plugin) => (plugin.packageName ? [plugin.packageName] : [])),
  );
  // Hosted rows without a declared runtime id fall back to their package name,
  // so id matching alone would keep them visible after a successful install.
  const entryPackageInstalled = (entry: OfficialExternalPluginCatalogEntry) =>
    resolveCatalogPackageSourceIdentities(entry).some((identity) =>
      installedPackageNames.has(identity.packageName),
    );
  for (const entry of officialCatalog.entries) {
    const pluginId = resolveOfficialExternalPluginId(entry);
    const manifest = getOfficialExternalPluginCatalogManifest(entry);
    const manifestCatalog = normalizeCatalogMetadata(manifest?.catalog);
    const catalog =
      manifestCatalog || typeof entry.featured === "boolean"
        ? {
            ...manifestCatalog,
            ...(manifestCatalog?.featured === undefined && typeof entry.featured === "boolean"
              ? { featured: entry.featured }
              : {}),
          }
        : undefined;
    if (!pluginId || !catalog || installedIds.has(pluginId) || entryPackageInstalled(entry)) {
      continue;
    }
    const kind = normalizeKinds(entry.kind);
    const install = resolveCatalogInstallAction({ entry, pluginId });
    const description = normalizeOptionalString(entry.description);
    const version = normalizeOptionalString(entry.version);
    const featuredAt =
      catalog.featured === true ? normalizeFeaturedAt(entry.featuredAt) : undefined;
    plugins.push({
      id: pluginId,
      name: resolveOfficialExternalPluginLabel(entry),
      ...(description ? { description } : {}),
      ...(version ? { version } : {}),
      ...(kind ? { kind } : {}),
      origin: "official",
      installed: false,
      enabled: false,
      state: "not-installed",
      ...(catalog.featured !== undefined ? { featured: catalog.featured } : {}),
      ...(featuredAt !== undefined ? { featuredAt } : {}),
      ...(catalog.order !== undefined ? { order: catalog.order } : {}),
      ...(resolveCatalogEntryIcon(entry) ? { hasIcon: true } : {}),
      ...(install ? { install } : {}),
    });
  }
  const diagnostics: unknown[] = [...metadata.diagnostics];
  if (officialCatalog.error) {
    diagnostics.push({
      level: "warn",
      message: `Official plugin catalog fallback: ${officialCatalog.error}`,
    });
  }
  return {
    plugins: plugins.toSorted(compareCatalogEntries),
    diagnostics,
    mutationAllowed: !resolveIsNixMode(env),
  };
}

function assertValidConfigSnapshot(
  prepared: Awaited<ReturnType<typeof readConfigFileSnapshotForWrite>>,
): ConfigSnapshotForInstallPersist {
  const { snapshot, writeOptions } = prepared;
  if (!snapshot.valid) {
    throw new ManagedPluginLifecycleError(
      "Config invalid; run `openclaw doctor --fix` before managing plugins.",
    );
  }
  const mutationWriteOptions = selectInstallMutationWriteOptions(writeOptions);
  const { pluginMutation } = resolveInstallConfigMutationPreflights({
    parsed: (snapshot.parsed ?? {}) as Record<string, unknown>,
    snapshotPath: snapshot.path,
    writeOptions: mutationWriteOptions,
  });
  if (pluginMutation.mode === "blocked") {
    throw new ManagedPluginLifecycleError(pluginMutation.reason);
  }
  return {
    config: snapshot.sourceConfig,
    baseHash: snapshot.hash,
    writeOptions: mutationWriteOptions,
  };
}

async function readPluginMutationSnapshot(
  env: NodeJS.ProcessEnv,
): Promise<ConfigSnapshotForInstallPersist> {
  try {
    assertConfigWriteAllowedInCurrentMode({ env });
  } catch (error) {
    throw new ManagedPluginLifecycleError(formatErrorMessage(error), { cause: error });
  }
  return assertValidConfigSnapshot(await readConfigFileSnapshotForWrite());
}

function createSilentRuntime(): RuntimeEnv {
  return {
    log: () => undefined,
    error: () => undefined,
    exit: (code) => {
      throw new ManagedPluginLifecycleError(`plugin lifecycle exited with code ${code}`);
    },
  };
}

function createInstallLogger(warnings: string[]) {
  return {
    info: () => undefined,
    warn: (message: string) => warnings.push(message),
  };
}

function resolveOfficialEntryById(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  pluginId: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) => resolveOfficialExternalPluginId(entry) === pluginId);
}

/** Explicitly declared runtime id, ignoring the entry-id fallback used for display. */
function resolveDeclaredOfficialPluginId(
  entry: OfficialExternalPluginCatalogEntry,
): string | undefined {
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  return (
    normalizeOptionalString(manifest?.plugin?.id) ??
    normalizeOptionalString(manifest?.channel?.id) ??
    normalizeOptionalString(manifest?.providers?.[0]?.id)
  );
}

function resolveOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  // Bundled identities remain the local trust anchor when a hosted feed omits
  // its ClawHub candidate; hosted install/version metadata is never copied back.
  return [...listOfficialExternalPluginCatalogEntries(), ...entries].find((entry) => {
    const install = resolveOfficialExternalPluginInstall(entry);
    return parseClawHubPluginSpec(install?.clawhubSpec ?? "")?.name === packageName;
  });
}

function resolveHostedOfficialEntryByClawHubPackage(
  entries: readonly OfficialExternalPluginCatalogEntry[],
  packageName: string,
): OfficialExternalPluginCatalogEntry | undefined {
  return entries.find((entry) => {
    const install = resolveOfficialExternalPluginInstall(entry);
    return parseClawHubPluginSpec(install?.clawhubSpec ?? "")?.name === packageName;
  });
}

function buildClawHubSpec(packageName: string, version?: string): string {
  const parsed = parseClawHubPluginSpec(`clawhub:${packageName}`);
  if (!parsed || parsed.version) {
    throw new ManagedPluginLifecycleError(`invalid ClawHub package name: ${packageName}`);
  }
  return `clawhub:${packageName}${version ? `@${version}` : ""}`;
}

function throwInstallFailure(result: {
  error: string;
  code?: string;
  version?: string;
  warning?: string;
}): never {
  const unavailable =
    !result.code ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.ARTIFACT_DOWNLOAD_UNAVAILABLE ||
    result.code === CLAWHUB_INSTALL_ERROR_CODE.CLAWHUB_SECURITY_UNAVAILABLE;
  throw new ManagedPluginLifecycleError(result.error, {
    kind: unavailable ? "unavailable" : "invalid-request",
    code: result.code,
    version: result.version,
    warning: result.warning,
    cause: result,
  });
}

function installRecordOwnsTarget(
  record: PluginInstallRecord | undefined,
  targetDir: string,
): boolean {
  return Boolean(
    record?.installPath && path.resolve(record.installPath) === path.resolve(targetDir),
  );
}

async function cleanupFailedManagedPluginInstall(params: {
  pluginId: string;
  install: PluginInstallRecord;
  targetDir: string;
  extensionsDir: string;
}): Promise<string[]> {
  let installRecords: Record<string, PluginInstallRecord>;
  try {
    installRecords = await loadInstalledPluginIndexInstallRecords();
  } catch (error) {
    return [
      `Could not verify whether the failed plugin install was committed; retained ${params.targetDir}: ${formatErrorMessage(error)}`,
    ];
  }
  if (installRecordOwnsTarget(installRecords[params.pluginId], params.targetDir)) {
    return [
      `Plugin install persistence reported an error after ${params.targetDir} was recorded; retained the managed target.`,
    ];
  }

  const plan = planPluginUninstall({
    config: {
      plugins: { installs: { [params.pluginId]: params.install } },
    },
    pluginId: params.pluginId,
    deleteFiles: true,
    extensionsDir: params.extensionsDir,
  });
  if (!plan.ok) {
    return [`Could not plan cleanup for failed plugin install: ${plan.error}`];
  }
  if (!plan.directoryRemoval) {
    return [
      `Could not resolve a managed cleanup target for failed plugin install ${params.pluginId}.`,
    ];
  }
  if (path.resolve(plan.directoryRemoval.target) !== path.resolve(params.targetDir)) {
    return [
      `Refused cleanup for failed plugin install ${params.pluginId}: planned target does not match the newly installed target.`,
    ];
  }
  try {
    const cleanup = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
    return cleanup.warnings;
  } catch (error) {
    return [
      `Failed to remove the newly installed target after plugin persistence failed: ${formatErrorMessage(error)}`,
    ];
  }
}

function throwPersistenceFailureWithCleanupWarnings(error: unknown, warnings: string[]): never {
  if (warnings.length === 0) {
    throw error;
  }
  const cleanupWarning = [...new Set(warnings)].join("\n");
  if (error instanceof ManagedPluginLifecycleError) {
    throw new ManagedPluginLifecycleError(error.message, {
      kind: error.kind,
      code: error.code,
      version: error.version,
      warning: [error.warning, cleanupWarning].filter(Boolean).join("\n"),
      cause: error,
    });
  }
  throw new ManagedPluginLifecycleError(formatErrorMessage(error), {
    kind: "unavailable",
    warning: cleanupWarning,
    cause: error,
  });
}

async function persistManagedPluginInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  pluginId: string;
  install: PluginInstallRecord;
  targetDir: string;
  extensionsDir: string;
}): Promise<OpenClawConfig> {
  try {
    return await persistPluginInstall({
      snapshot: params.snapshot,
      pluginId: params.pluginId,
      install: params.install,
      invalidateRuntimeCache: false,
      runtime: createSilentRuntime(),
    });
  } catch (error) {
    const cleanupWarnings = await cleanupFailedManagedPluginInstall({
      pluginId: params.pluginId,
      install: params.install,
      targetDir: params.targetDir,
      extensionsDir: params.extensionsDir,
    });
    return throwPersistenceFailureWithCleanupWarnings(error, cleanupWarnings);
  }
}

async function installFromClawHub(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "clawhub" }>;
  snapshot: ConfigSnapshotForInstallPersist;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  env: NodeJS.ProcessEnv;
  warnings: string[];
  expectedIntegrity?: string;
}): Promise<{ pluginId: string; config: OpenClawConfig }> {
  const packageName = params.request.packageName.trim();
  const official = resolveOfficialEntryByClawHubPackage(params.officialEntries, packageName);
  // Pin the runtime id only when the catalog entry declares one; the entry-id
  // fallback is just the package name and would reject legitimate installs,
  // while a declared id must stay enforced even if it equals the package name.
  const expectedPluginId = official ? resolveDeclaredOfficialPluginId(official) : undefined;
  const hostedOfficial = resolveHostedOfficialEntryByClawHubPackage(
    params.officialEntries,
    packageName,
  );
  const hostedInstall = hostedOfficial
    ? resolveOfficialExternalPluginInstall(hostedOfficial)
    : undefined;
  const hostedClawHub = parseClawHubPluginSpec(hostedInstall?.clawhubSpec ?? "");
  const requestMatchesHostedCandidate =
    !params.request.version || params.request.version === hostedClawHub?.version;
  const expectedIntegrity =
    params.expectedIntegrity ??
    (requestMatchesHostedCandidate ? hostedInstall?.expectedIntegrity : undefined);
  const version =
    params.request.version ?? (requestMatchesHostedCandidate ? hostedClawHub?.version : undefined);
  const spec = buildClawHubSpec(packageName, version);
  const extensionsDir = resolveDefaultPluginExtensionsDir(params.env);
  const result = await installPluginFromClawHub({
    spec,
    config: params.snapshot.config,
    extensionsDir,
    logger: createInstallLogger(params.warnings),
    ...(expectedPluginId ? { expectedPluginId } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
    ...(params.request.acknowledgeClawHubRisk ? { acknowledgeClawHubRisk: true } : {}),
  });
  if (!result.ok) {
    return throwInstallFailure(result);
  }
  if (expectedPluginId && result.pluginId !== expectedPluginId) {
    throw new ManagedPluginLifecycleError(
      `official catalog plugin id mismatch: expected ${expectedPluginId}, got ${result.pluginId}`,
    );
  }
  const install: PluginInstallRecord = {
    ...buildClawHubPluginInstallRecordFields(result.clawhub),
    spec,
    installPath: result.targetDir,
  };
  const config = await persistManagedPluginInstall({
    snapshot: params.snapshot,
    pluginId: result.pluginId,
    install,
    targetDir: result.targetDir,
    extensionsDir,
  });
  return { pluginId: result.pluginId, config };
}

async function installFromOfficialCatalog(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "official" }>;
  snapshot: ConfigSnapshotForInstallPersist;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  env: NodeJS.ProcessEnv;
  warnings: string[];
}): Promise<{ pluginId: string; config: OpenClawConfig }> {
  const entry = resolveOfficialEntryById(params.officialEntries, params.request.pluginId);
  if (!entry) {
    throw new ManagedPluginLifecycleError(
      `unknown official plugin catalog entry: ${params.request.pluginId}`,
    );
  }
  const pluginId = resolveOfficialExternalPluginId(entry);
  const install = resolveOfficialExternalPluginInstall(entry);
  if (!pluginId || !install) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry is not installable: ${params.request.pluginId}`,
    );
  }
  const clawhub = install.clawhubSpec ? parseClawHubPluginSpec(install.clawhubSpec) : undefined;
  if (clawhub) {
    return await installFromClawHub({
      request: {
        source: "clawhub",
        packageName: clawhub.name,
        ...(clawhub.version ? { version: clawhub.version } : {}),
      },
      snapshot: params.snapshot,
      officialEntries: params.officialEntries,
      env: params.env,
      warnings: params.warnings,
      ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
    });
  }
  if (!install.npmSpec) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry has no supported install source: ${params.request.pluginId}`,
    );
  }
  const extensionsDir = resolveDefaultPluginExtensionsDir(params.env);
  const result = await installPluginFromNpmSpec({
    spec: install.npmSpec,
    config: params.snapshot.config,
    extensionsDir,
    expectedPluginId: pluginId,
    ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
    trustedSourceLinkedOfficialInstall: true,
    logger: createInstallLogger(params.warnings),
  });
  if (!result.ok) {
    return throwInstallFailure(result);
  }
  if (result.pluginId !== pluginId) {
    throw new ManagedPluginLifecycleError(
      `official catalog plugin id mismatch: expected ${pluginId}, got ${result.pluginId}`,
    );
  }
  const installRecord: PluginInstallRecord = {
    source: "npm",
    spec: install.npmSpec,
    installPath: result.targetDir,
    ...(result.version ? { version: result.version } : {}),
    ...buildNpmResolutionInstallFields(result.npmResolution),
  };
  const config = await persistManagedPluginInstall({
    snapshot: params.snapshot,
    pluginId,
    install: installRecord,
    targetDir: result.targetDir,
    extensionsDir,
  });
  return { pluginId, config };
}

/** Install a ClawHub or curated official plugin through the canonical install pipeline. */
export async function installManagedPlugin(params: {
  request: ManagedPluginInstallRequest;
  env?: NodeJS.ProcessEnv;
}): Promise<{ plugin: ManagedPluginCatalogEntry; warnings?: string[] }> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async () => {
    const snapshot = await readPluginMutationSnapshot(env);
    const officialCatalog = await loadOfficialCatalog();
    const warnings: string[] = [];
    const installed =
      params.request.source === "clawhub"
        ? await installFromClawHub({
            request: params.request,
            snapshot,
            officialEntries: officialCatalog.entries,
            env,
            warnings,
          })
        : await installFromOfficialCatalog({
            request: params.request,
            snapshot,
            officialEntries: officialCatalog.entries,
            env,
            warnings,
          });
    const catalog = await listManagedPlugins({
      config: installed.config,
      env,
      officialCatalog,
    });
    const plugin = catalog.plugins.find((entry) => entry.id === installed.pluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `installed plugin missing from refreshed registry: ${installed.pluginId}`,
      );
    }
    return {
      plugin,
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    };
  });
}

/** Persist desired plugin policy while preserving allow/deny, slot, include, and hash guards. */
export async function setManagedPluginEnabled(params: {
  pluginId: string;
  enabled: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  plugin: ManagedPluginCatalogEntry;
  changedPaths: string[];
  warnings?: string[];
}> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async () => {
    const snapshot = await readPluginMutationSnapshot(env);
    const metadata = loadPluginMetadataSnapshot({ config: snapshot.config, env });
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    if (!metadata.index.plugins.some((plugin) => plugin.pluginId === pluginId)) {
      throw new ManagedPluginLifecycleError(`plugin not installed: ${params.pluginId}`);
    }
    let next = snapshot.config;
    const warnings: string[] = [];
    let policyPluginId = pluginId;
    if (params.enabled) {
      // The admin-scoped enable RPC is an explicit trust action. Preserve the
      // existing inventory while admitting only the selected installed plugin.
      if ((next.plugins?.allow?.length ?? 0) > 0) {
        next = ensurePluginAllowlisted(next, pluginId);
      }
      const enableResult = enableExplicitlySelectedPluginInConfig(next, pluginId, {
        updateChannelConfig: false,
      });
      if (!enableResult.enabled) {
        throw new ManagedPluginLifecycleError(
          `plugin "${pluginId}" could not be enabled (${enableResult.reason ?? "unknown reason"})`,
        );
      }
      next = enableResult.config;
      policyPluginId = enableResult.pluginId;
      const slotResult = applySlotSelectionForPlugin(next, pluginId);
      next = slotResult.config;
      warnings.push(...slotResult.warnings);
    } else {
      next = setPluginEnabledInConfig(next, pluginId, false, { updateChannelConfig: false });
    }
    const changedPaths = new Set<string>();
    collectChangedPaths(snapshot.config, next, "", changedPaths);
    await replaceConfigFile({
      nextConfig: next,
      baseHash: snapshot.baseHash,
      writeOptions: snapshot.writeOptions,
    });
    await refreshPluginRegistryAfterConfigMutation({
      config: next,
      reason: "policy-changed",
      invalidateRuntimeCache: false,
      policyPluginIds: [policyPluginId],
    });
    const catalog = await listManagedPlugins({ config: next, env });
    const plugin = catalog.plugins.find((entry) => entry.id === pluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `updated plugin missing from refreshed registry: ${pluginId}`,
      );
    }
    return {
      plugin,
      changedPaths: [...changedPaths].filter(Boolean).toSorted(),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  });
}

/** Remove an installed plugin: config references, install record, and managed files. */
export async function uninstallManagedPlugin(params: {
  pluginId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ pluginId: string; removed: string[]; warnings?: string[] }> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async () => {
    const snapshot = await readPluginMutationSnapshot(env);
    const installRecords = await loadInstalledPluginIndexInstallRecords();
    // Mirror the CLI uninstall flow: plan against config carrying install records
    // so managed npm/git directories resolve, then persist the stripped config.
    const configWithRecords = withPluginInstallRecords(snapshot.config, installRecords);
    const metadata = loadPluginMetadataSnapshot({ config: configWithRecords, env });
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    const record = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (record?.origin === "bundled") {
      throw new ManagedPluginLifecycleError(
        `bundled plugin cannot be uninstalled: ${pluginId}; disable it instead`,
      );
    }
    const manifest = metadata.byPluginId.get(pluginId);
    // Mirror the CLI cold path: pass channel ownership only when declared so
    // planPluginUninstall keeps its plugin-id fallback for channel config keys.
    const channelIds = manifest && manifest.channels.length > 0 ? manifest.channels : undefined;
    const extensionsDir = resolveDefaultPluginExtensionsDir(env);
    const initialPlan = planPluginUninstall({
      config: configWithRecords,
      pluginId,
      ...(channelIds ? { channelIds } : {}),
      deleteFiles: true,
      extensionsDir,
    });
    if (!initialPlan.ok) {
      throw new ManagedPluginLifecycleError(initialPlan.error);
    }
    let plan = initialPlan;
    let finalSnapshot = snapshot;
    let directoryResult = { directoryRemoved: false, warnings: [] as string[] };
    if (plan.directoryRemoval) {
      const disabledConfig = prepareConfigForPendingPluginDirectoryRemoval(
        snapshot.config,
        pluginId,
        { channelIds },
      );
      await replaceConfigFile({
        nextConfig: disabledConfig,
        baseHash: snapshot.baseHash,
        writeOptions: {
          ...snapshot.writeOptions,
          afterWrite: { mode: "auto" },
        },
      });
      directoryResult = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
      if (pluginUninstallTargetExists(plan.directoryRemoval.target)) {
        throw new ManagedPluginLifecycleError(
          `Failed to remove plugin directory ${plan.directoryRemoval.target}; the plugin remains disabled and tracked so uninstall can be retried.`,
          { kind: "unavailable" },
        );
      }
      finalSnapshot = await readPluginMutationSnapshot(env);
      const refreshedConfigWithRecords = withPluginInstallRecords(
        finalSnapshot.config,
        installRecords,
      );
      const refreshedPlan = planPluginUninstall({
        config: refreshedConfigWithRecords,
        pluginId,
        ...(channelIds ? { channelIds } : {}),
        deleteFiles: true,
        extensionsDir,
      });
      if (!refreshedPlan.ok) {
        throw new ManagedPluginLifecycleError(refreshedPlan.error);
      }
      plan = refreshedPlan;
    }
    const nextConfig = withoutPluginInstallRecords(plan.config);
    const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, pluginId);
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: installRecords,
      nextInstallRecords,
      nextConfig,
      baseHash: finalSnapshot.baseHash,
      writeOptions: finalSnapshot.writeOptions,
    });
    const warnings = [
      ...collectClawPluginUninstallWarnings({
        pluginId,
        installRecord: installRecords[pluginId],
        env,
      }),
      ...directoryResult.warnings,
    ];
    await refreshPluginRegistryAfterConfigMutation({
      config: nextConfig,
      reason: "source-changed",
      installRecords: nextInstallRecords,
      invalidateRuntimeCache: false,
      logger: { warn: (message) => warnings.push(message) },
    });
    const removed = formatUninstallActionLabels({
      ...plan.actions,
      directory: directoryResult.directoryRemoved,
    });
    return {
      pluginId,
      removed,
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    };
  });
}

/** Normalize unexpected lifecycle failures for Gateway response adapters. */
export function formatManagedPluginLifecycleError(error: unknown): string {
  return formatErrorMessage(error);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

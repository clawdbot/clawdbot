// Structured plugin catalog and lifecycle operations shared by Gateway-facing surfaces.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { asSafeIntegerInRange } from "@openclaw/normalization-core/number-coercion";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import type {
  PluginInspectSource,
  PluginsInspectResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import { collectChangedPaths } from "../config/config-change-paths.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshotForWrite,
  replaceConfigFile,
} from "../config/config.js";
import { resolveIsNixMode } from "../config/paths.js";
import { ensurePluginAllowlisted } from "../config/plugins-allowlist.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { parseClawHubPluginSpec } from "../infra/clawhub-spec.js";
import { formatErrorMessage } from "../infra/errors.js";
import { buildNpmResolutionFields, type NpmSpecResolution } from "../infra/install-source-utils.js";
import { parseRegistryNpmSpec } from "../infra/npm-registry-spec.js";
import { normalizeUpdateChannel, resolveRegistryUpdateChannel } from "../infra/update-channels.js";
import type { RuntimeEnv } from "../runtime.js";
import { VERSION } from "../version.js";
import { installBundledPluginSource } from "./bundled-install.js";
import type { BundledPluginSource } from "./bundled-sources.js";
import {
  prepareManagedPluginArtifactConsentHandler,
  resolvePendingPluginCapabilityReview,
  resolvePluginCapabilityConsent,
  resolvePluginInstallRecordTrust,
  type PluginCapabilityConsentAcknowledgment,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import {
  buildPluginCapabilitySummary,
  computeDeclaredSurfaceHash,
  formatPluginCapabilityConsentRequired,
  resolveAcceptedSurfaceCurrent,
  resolvePluginInstallRecordIntegrity,
  resolvePluginPackageDeclaredSurface,
} from "./capability-summary.js";
import { CLAWHUB_INSTALL_ERROR_CODE, isUnavailableClawHubTarget } from "./clawhub-error-codes.js";
import {
  buildClawHubPluginInstallRecordFields,
  type ClawHubPluginInstallRecordFields,
} from "./clawhub-install-records.js";
import { installPluginFromClawHub } from "./clawhub.js";
import {
  appendPluginControlPlaneWorkspaceDiagnostic,
  resolvePluginControlPlaneWorkspace,
} from "./control-plane-workspace.js";
import { enableExplicitlySelectedPluginInConfig } from "./enable.js";
import { installPluginFromGitSpec } from "./git-install.js";
import {
  resolveClawHubInstallSpecsForUpdateChannel,
  resolveNpmInstallSpecsForUpdateChannel,
} from "./install-channel-specs.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import {
  resolveInstallConfigMutationPreflights,
  selectInstallMutationWriteOptions,
  persistPluginInstall,
  type ConfigSnapshotForInstallPersist,
} from "./install-persistence.js";
import { commitPluginInstallRecordsWithConfig } from "./install-record-commit.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import type { InstallPolicyWarningDetails } from "./install-security-scan.types.js";
import {
  requestDeferredPluginInstall,
  resolvePluginInstallTransaction,
  type PluginInstallTransaction,
} from "./install-transaction.js";
import {
  isUnavailableNpmTarget,
  PLUGIN_INSTALL_ERROR_CODE,
  type PluginInstallLogger,
} from "./install-types.js";
import {
  installPluginFromNpmPackArchive,
  installPluginFromNpmSpec,
  installPluginFromPath,
} from "./install.js";
import {
  loadInstalledPluginIndexInstallRecords,
  removePluginInstallRecordFromRecords,
  withPluginInstallRecords,
  withoutPluginInstallRecords,
} from "./installed-plugin-index-records.js";
import { resolveInstalledPluginPackageOwnership } from "./installed-plugin-package-ownership.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import { installPluginFromMarketplace } from "./marketplace.js";
import {
  resolveTrustedOfficialClawHubPackageName,
  resolveTrustedSourceLinkedOfficialClawHubSpec,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "./official-external-install-records.js";
import {
  getOfficialExternalPluginCatalogEntryForPackage,
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  loadConfiguredHostedOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginInstall,
  resolveOfficialExternalPluginLabel,
  type HostedOfficialExternalPluginCatalogLoadResult,
  type OfficialExternalPluginCatalogEntry,
} from "./official-external-plugin-catalog.js";
import { createConfigScopedPromiseLoader } from "./plugin-cache-primitives.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import {
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { resolveManifestProviderAuthChoices } from "./provider-auth-choices.js";
import { listRecommendedToolInstalls } from "./recommended-tool-installs.js";
import { refreshPluginRegistryAfterConfigMutation } from "./registry-refresh.js";
import { applySlotSelectionForPlugin } from "./slot-selection.js";
import {
  buildPluginDependencyStatus,
  projectPluginDependencyHealth,
} from "./status-dependencies-core.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";
import { collectClawPluginUninstallWarnings } from "./uninstall-claw-references.js";
import {
  prepareConfigForPendingPluginDirectoryRemovalSet,
  recordPluginPackageUninstallPlan,
} from "./uninstall-package-plan.js";
import {
  applyPluginUninstallDirectoryRemoval,
  formatUninstallActionLabels,
  planPluginUninstall,
  pluginUninstallTargetExists,
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

export type ManagedPluginInspection = PluginsInspectResult;

type ManagedPluginInstallRequest =
  | {
      source: "clawhub";
      packageName: string;
      version?: string;
      acknowledgeInstallPolicyWarning?: true;
      acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    }
  | {
      source: "official";
      pluginId: string;
      acknowledgeInstallPolicyWarning?: true;
      acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
    };

export type ManagedPluginSourceInstallRequest =
  | {
      source: "local";
      path: string;
      recordSource: "archive" | "path";
      mode: "install" | "update";
      link?: boolean;
      bundledOrigin?: true;
      successMessage?: string;
    }
  | {
      source: "npm-pack";
      archivePath: string;
      mode: "install" | "update";
    }
  | { source: "git"; spec: string; mode: "install" | "update" }
  | {
      source: "marketplace";
      marketplace: string;
      plugin: string;
      mode: "install" | "update";
    }
  | {
      source: "clawhub";
      spec: string;
      /** Spec recorded for the install; keeps user intent when `spec` is channel-resolved. */
      recordSpec?: string;
      mode?: "install" | "update";
      expectedPluginId?: string;
      expectedIntegrity?: string;
      /** Host-validated official catalog provenance for release-cohort resolution. */
      trustedSourceLinkedOfficialInstall?: true;
      confirmInstall?: NonNullable<
        Parameters<typeof installPluginFromClawHub>[0]["confirmInstall"]
      >;
    }
  | {
      source: "bundled";
      rawSpec: string;
      bundledSource: BundledPluginSource;
      warning?: string;
    }
  | {
      source: "official";
      spec: string;
      /** Spec recorded for the install; keeps user intent when `spec` is channel-resolved. */
      recordSpec?: string;
      pluginId: string;
      expectedIntegrity?: string;
      mode: "install" | "update";
      pin?: boolean;
    }
  | {
      source: "npm";
      spec: string;
      /** Spec recorded for the install; keeps user intent when `spec` is channel-resolved. */
      recordSpec?: string;
      mode: "install" | "update";
      pin?: boolean;
      expectedPluginId?: string;
      expectedIntegrity?: string;
      trustedSourceLinkedOfficialInstall?: boolean;
      allowBundledFallback?: boolean;
    };

type ManagedPluginSourceInstallResult =
  | {
      ok: true;
      pluginId: string;
      config: OpenClawConfig;
      warnings?: string[];
      targetDir?: string;
      version?: string;
      npmResolution?: NpmSpecResolution;
      clawhub?: ClawHubPluginInstallRecordFields;
    }
  | {
      ok: false;
      error: string;
      code?: string;
      version?: string;
      warning?: string;
      installPolicyWarning?: InstallPolicyWarningDetails;
    };

type SourceInstallerResult =
  | {
      ok: false;
      error: string;
      code?: string;
      version?: string;
      warning?: string;
      installPolicyWarning?: InstallPolicyWarningDetails;
    }
  | {
      ok: true;
      pluginId: string;
      targetDir: string;
      version?: string;
      npmResolution?: NpmSpecResolution;
    };

type OfficialCatalogResult = Pick<HostedOfficialExternalPluginCatalogLoadResult, "entries"> & {
  error?: string;
  hostedFeaturedAuthoritative?: boolean;
};

const officialCatalogLoader = createConfigScopedPromiseLoader(() =>
  loadConfiguredHostedOfficialExternalPluginCatalogEntries(),
);
let pluginDependencyDiagnostics = new WeakMap<PluginMetadataSnapshot, PluginDiagnostic[]>();

// Package dependency probes belong to one metadata generation, never each Gateway request.
registerPluginMetadataProcessMemoLifecycleClear(() => {
  pluginDependencyDiagnostics = new WeakMap();
});

function resolveManagedPluginDiagnostics(snapshot: PluginMetadataSnapshot): PluginDiagnostic[] {
  const cached = pluginDependencyDiagnostics.get(snapshot);
  if (cached) {
    return cached;
  }
  const { diagnostics } = projectPluginDependencyHealth({
    plugins: snapshot.index.plugins.map((record) => {
      const manifest = snapshot.byPluginId.get(record.pluginId);
      return {
        id: record.pluginId,
        source: manifest?.source ?? record.source ?? record.manifestPath,
        enabled: record.enabled,
        status: record.enabled ? ("loaded" as const) : ("disabled" as const),
        dependencyStatus:
          record.origin === "bundled"
            ? undefined
            : buildPluginDependencyStatus({
                rootDir: record.rootDir,
                dependencies: manifest?.packageDependencies,
                optionalDependencies: manifest?.packageOptionalDependencies,
              }),
      };
    }),
    diagnostics: [...snapshot.diagnostics],
  });
  pluginDependencyDiagnostics.set(snapshot, diagnostics);
  return diagnostics;
}

/** Clear the process-stable hosted catalog snapshot after an explicit owner reload. */
export function clearManagedPluginOfficialCatalogCache(): void {
  officialCatalogLoader.clear();
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
  const result = await officialCatalogLoader.load();
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
  return asSafeIntegerInRange(value, { min: 0 });
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

type PluginIndexRecord = PluginMetadataSnapshot["index"]["plugins"][number];

function resolveInstalledPluginPresentation(params: {
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

function resolveInstalledHostedOfficialEntry(params: {
  record: PluginIndexRecord;
  installOwner?: string;
  installRecord?: PluginInstallRecord;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  bundledOfficialEntries: readonly OfficialExternalPluginCatalogEntry[];
}): {
  entry?: OfficialExternalPluginCatalogEntry;
  hasPublishedIdentity: boolean;
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
  const ownership = resolveInstalledPluginPackageOwnership(params.metadata.index, record.pluginId);
  const installOwner = ownership.ok ? ownership.value.installOwner : undefined;
  const { entry: officialEntry } = resolveInstalledHostedOfficialEntry({
    record,
    ...(installOwner ? { installOwner } : {}),
    installRecord: installOwner ? params.metadata.index.installRecords[installOwner] : undefined,
    officialEntries: params.officialEntries,
    bundledOfficialEntries:
      params.bundledOfficialEntries ?? listOfficialExternalPluginCatalogEntries(),
  });
  return resolveCatalogEntryIcon(officialEntry) ?? localIcon;
}

function resolveManagedPluginMetadataParams(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  const workspace = resolvePluginControlPlaneWorkspace({ config, env });
  return {
    config,
    env,
    ...(workspace.workspaceDir !== undefined ? { workspaceDir: workspace.workspaceDir } : {}),
  };
}

/** Resolve the current manifest/catalog icon URL without accepting a caller-provided URL. */
export async function resolveManagedPluginIconUrl(params: {
  config: OpenClawConfig;
  pluginId: string;
  env?: NodeJS.ProcessEnv;
  officialCatalog?: OfficialCatalogResult;
}): Promise<string | undefined> {
  const env = params.env ?? process.env;
  const metadata = resolvePluginMetadataSnapshot(
    resolveManagedPluginMetadataParams(params.config, env),
  );
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
  const workspace = resolvePluginControlPlaneWorkspace({ config: params.config, env });
  const metadata = resolvePluginMetadataSnapshot({
    config: params.config,
    env,
    ...(workspace.workspaceDir !== undefined ? { workspaceDir: workspace.workspaceDir } : {}),
  });
  const pluginDiagnostics = resolveManagedPluginDiagnostics(metadata);
  const officialCatalog = params.officialCatalog ?? (await loadOfficialCatalog());
  const bundledOfficialEntries = listOfficialExternalPluginCatalogEntries();
  const capabilityConsentDiagnostics: PluginDiagnostic[] = [];
  const plugins = metadata.index.plugins.map((record): ManagedPluginCatalogEntry => {
    const manifest = metadata.byPluginId.get(record.pluginId);
    const localCatalog = normalizeCatalogMetadata(manifest?.catalog);
    const ownership = resolveInstalledPluginPackageOwnership(metadata.index, record.pluginId);
    const installOwner = ownership.ok ? ownership.value.installOwner : undefined;
    const installRecord = installOwner ? metadata.index.installRecords[installOwner] : undefined;
    if (record.enabled && record.origin !== "bundled" && ownership.ok && installRecord) {
      const declared = resolvePluginPackageDeclaredSurface(ownership.value, metadata.byPluginId);
      if (!declared || !resolveAcceptedSurfaceCurrent(installRecord, declared)) {
        capabilityConsentDiagnostics.push({
          level: "warn",
          pluginId: record.pluginId,
          message: formatPluginCapabilityConsentRequired(record.pluginId),
        });
      }
    }
    const { entry: officialEntry, hasPublishedIdentity } = resolveInstalledHostedOfficialEntry({
      record,
      ...(installOwner ? { installOwner } : {}),
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
    const error = firstPluginError(pluginDiagnostics, record.pluginId);
    const kind = normalizeKinds(manifest?.kind);
    const category = derivePluginCategory(manifest);
    // Only externally installed plugins (tracked install record, non-bundled) can be removed.
    const removable = record.origin !== "bundled" && Boolean(installOwner);
    const hostedListingAuthoritative =
      hasHostedOfficialIdentity && officialCatalog.hostedFeaturedAuthoritative === true;
    const featuredAt =
      hostedListingAuthoritative && catalog?.featured === true
        ? normalizeFeaturedAt(officialEntry?.featuredAt)
        : undefined;
    const presentation = resolveInstalledPluginPresentation({
      record,
      manifest,
      officialEntry,
      hostedListingAuthoritative,
    });
    const plugin: ManagedPluginCatalogEntry = {
      id: record.pluginId,
      name: presentation.name,
      installed: true,
      enabled: record.enabled,
      state: error ? "error" : record.enabled ? "enabled" : "disabled",
      removable,
    };
    if (record.packageName) {
      plugin.packageName = record.packageName;
    }
    if (presentation.description) {
      plugin.description = presentation.description;
    }
    if (presentation.version) {
      plugin.version = presentation.version;
    }
    if (kind) {
      plugin.kind = kind;
    }
    if (record.origin) {
      plugin.origin = record.origin;
    }
    if (catalog?.featured !== undefined) {
      plugin.featured = catalog.featured;
    }
    if (featuredAt !== undefined) {
      plugin.featuredAt = featuredAt;
    }
    if (catalog?.order !== undefined) {
      plugin.order = catalog.order;
    }
    if (
      resolvePluginIconUrlFromCatalogFacts({
        metadata,
        officialEntries: officialCatalog.entries,
        bundledOfficialEntries,
        pluginId: record.pluginId,
      })
    ) {
      plugin.hasIcon = true;
    }
    if (error) {
      plugin.error = error;
    }
    if (category) {
      plugin.category = category;
    }
    return plugin;
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
    const clawhubPackageName = resolveCatalogPackageSourceIdentities(entry).find(
      (identity) => identity.source === "clawhub",
    )?.packageName;
    const description = normalizeOptionalString(entry.description);
    const version = normalizeOptionalString(entry.version);
    const featuredAt =
      catalog.featured === true ? normalizeFeaturedAt(entry.featuredAt) : undefined;
    plugins.push({
      id: pluginId,
      name: resolveOfficialExternalPluginLabel(entry),
      ...(clawhubPackageName ? { packageName: clawhubPackageName } : {}),
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
  const diagnostics: unknown[] = appendPluginControlPlaneWorkspaceDiagnostic(
    [...pluginDiagnostics, ...capabilityConsentDiagnostics],
    workspace,
  );
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

/** Inspect one plugin's manifest, operator grants, and recorded install provenance. */
export async function inspectManagedPlugin(params: {
  config: OpenClawConfig;
  pluginId: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ManagedPluginInspection> {
  const env = params.env ?? process.env;
  const metadata = resolvePluginMetadataSnapshot(
    resolveManagedPluginMetadataParams(params.config, env),
  );
  const pluginId = metadata.normalizePluginId(params.pluginId);
  const record = metadata.index.plugins.find((candidate) => candidate.pluginId === pluginId);
  const pendingReview = resolvePendingPluginCapabilityReview(pluginId);
  if (pendingReview) {
    return {
      ok: true,
      plugin: {
        id: pluginId,
        name: pendingReview.name,
        ...(pendingReview.version ? { version: pendingReview.version } : {}),
        ...(record?.origin ? { origin: record.origin } : {}),
        installed: Boolean(record),
        enabled: record?.enabled ?? false,
      },
      declared: pendingReview.declared,
      grants: pendingReview.grants,
      reviewToken: pendingReview.reviewToken,
      ...(pendingReview.source ? { source: pendingReview.source } : {}),
      ...(pendingReview.trust ? { trust: pendingReview.trust } : {}),
    };
  }
  const officialCatalog = await loadOfficialCatalog();

  if (record) {
    const manifest = metadata.byPluginId.get(pluginId);
    const ownership = resolveInstalledPluginPackageOwnership(metadata.index, pluginId, env);
    const installOwner = ownership.ok ? ownership.value.installOwner : undefined;
    const installRecord = installOwner ? metadata.index.installRecords[installOwner] : undefined;
    const { entry: officialEntry, hasPublishedIdentity } = resolveInstalledHostedOfficialEntry({
      record,
      ...(installOwner ? { installOwner } : {}),
      installRecord,
      officialEntries: officialCatalog.entries,
      bundledOfficialEntries: listOfficialExternalPluginCatalogEntries(),
    });
    const spec = installRecord?.resolvedSpec ?? installRecord?.spec;
    const packageName = installRecord?.clawhubPackage ?? record.packageName;
    const source: PluginInspectSource | undefined = installRecord
      ? {
          kind: installRecord.source,
          ...(spec ? { spec: redactSensitiveUrlLikeString(spec) } : {}),
          ...(packageName ? { packageName } : {}),
          ...resolvePluginInstallRecordIntegrity(installRecord),
        }
      : record.origin === "bundled"
        ? { kind: "bundled" }
        : undefined;
    const trust = resolvePluginInstallRecordTrust(installRecord);
    const summary = buildPluginCapabilitySummary({
      manifest: manifest ?? {},
      origin: record.origin,
      entryConfig: params.config.plugins?.entries?.[pluginId],
    });
    const declared = ownership.ok
      ? resolvePluginPackageDeclaredSurface(ownership.value, metadata.byPluginId)
      : summary.declared;
    if (!declared) {
      throw new ManagedPluginLifecycleError(
        `Plugin package "${installOwner}" has incomplete manifest metadata.`,
      );
    }
    return {
      ok: true,
      plugin: {
        id: pluginId,
        ...resolveInstalledPluginPresentation({
          record,
          manifest,
          officialEntry,
          hostedListingAuthoritative:
            hasPublishedIdentity && officialCatalog.hostedFeaturedAuthoritative === true,
        }),
        origin: record.origin,
        installed: true,
        enabled: record.enabled,
      },
      ...(source ? { source } : {}),
      ...summary,
      declared,
      reviewToken: computeDeclaredSurfaceHash(declared),
      ...(trust ? { trust } : {}),
    };
  }

  const entry = resolveOfficialEntryById(officialCatalog.entries, pluginId);
  if (!entry) {
    throw new ManagedPluginLifecycleError(`Plugin "${pluginId}" not found.`, {
      kind: "invalid-request",
    });
  }
  const manifest = getOfficialExternalPluginCatalogManifest(entry);
  const install = resolveOfficialExternalPluginInstall(entry);
  const packageName = resolveCatalogPackageSourceIdentities(entry)[0]?.packageName;
  const spec = install?.clawhubSpec ?? install?.npmSpec;
  const description = normalizeOptionalString(entry.description);
  const version = normalizeOptionalString(entry.version);
  const summary = buildPluginCapabilitySummary({
    manifest: manifest ?? {},
    origin: "official",
    entryConfig: params.config.plugins?.entries?.[pluginId],
  });
  return {
    ok: true,
    plugin: {
      id: pluginId,
      name: resolveOfficialExternalPluginLabel(entry),
      ...(version ? { version } : {}),
      ...(description ? { description } : {}),
      origin: "official",
      installed: false,
      enabled: false,
    },
    source: {
      kind: "official-catalog",
      ...(spec ? { spec: redactSensitiveUrlLikeString(spec) } : {}),
      ...(packageName ? { packageName } : {}),
      ...(install?.expectedIntegrity
        ? {
            integrity: install.expectedIntegrity,
            integrityKind: install.defaultChoice === "clawhub" ? "sha256" : "ssri",
          }
        : {}),
    },
    ...summary,
    reviewToken: computeDeclaredSurfaceHash(summary.declared),
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
  installPolicyWarning?: InstallPolicyWarningDetails;
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
    installPolicyWarning: result.installPolicyWarning,
    cause: result,
  });
}

async function persistManagedSourceInstall(params: {
  snapshot: ConfigSnapshotForInstallPersist;
  pluginId: string;
  install: PluginInstallRecord;
  transaction?: PluginInstallTransaction;
  invalidateRuntimeCache?: boolean;
  runtime?: RuntimeEnv;
  successMessage?: string;
}): Promise<{ config: OpenClawConfig; warnings: string[] }> {
  const warnings: string[] = [];
  let committed = false;
  try {
    const config = await persistPluginInstall({
      snapshot: params.snapshot,
      pluginId: params.pluginId,
      install: params.install,
      invalidateRuntimeCache: params.invalidateRuntimeCache,
      runtime: params.runtime,
      persistenceLogger: { warn: (message) => warnings.push(message) },
      // Only the persistence owner can distinguish rejection from a late refresh failure.
      onCommitted: () => {
        committed = true;
      },
      ...(params.successMessage ? { successMessage: params.successMessage } : {}),
    });
    return { config, warnings };
  } catch (error) {
    if (!committed) {
      try {
        await params.transaction?.rollback();
      } catch (rollbackError) {
        // oxlint-disable-next-line preserve-caught-error -- Oxlint 1.78 ignores AggregateError's third-argument cause.
        throw new AggregateError(
          [error, rollbackError],
          "Plugin install failed and payload rollback failed",
          { cause: rollbackError },
        );
      }
    }
    throw error;
  } finally {
    if (committed) {
      await params.transaction?.commit().catch(() => {
        const warning = "Plugin install committed, but backup cleanup failed. Restart is required.";
        warnings.push(warning);
        params.runtime?.log(warning);
      });
    }
  }
}

/**
 * Official plugin installs target the release stream the gateway is running,
 * the same target `openclaw doctor --fix` and `openclaw plugins update`
 * already resolve. Resolving here keeps every managed install path — CLI,
 * chat command, and any future caller — on one answer instead of letting the
 * registry default land a plugin the gateway then reports as drifted.
 *
 * Only the beta stream resolves here. The version-bound stable tracks key off a
 * per-plugin `versionBoundToOpenClaw` descriptor that a managed install request
 * does not carry, and answering for them from this boundary would pin plugins
 * the policy never opted in.
 */
function resolveOfficialManagedInstallSpec(params: {
  request: Extract<ManagedPluginSourceInstallRequest, { source: "official" | "npm" | "clawhub" }>;
  config: OpenClawConfig;
}): string | null {
  const { request } = params;
  const trustedSourceLinkedOfficialInstall =
    request.source !== "official" && request.trustedSourceLinkedOfficialInstall === true;
  if (request.source === "npm" && !trustedSourceLinkedOfficialInstall) {
    return null;
  }
  // An integrity pin identifies one exact artifact, so it outranks the channel.
  if (request.expectedIntegrity) {
    return null;
  }
  const packageName =
    request.source === "clawhub"
      ? parseClawHubPluginSpec(request.spec)?.name
      : parseRegistryNpmSpec(request.spec)?.name;
  if (
    !packageName ||
    (request.source !== "official" &&
      !trustedSourceLinkedOfficialInstall &&
      !getOfficialExternalPluginCatalogEntryForPackage(packageName))
  ) {
    return null;
  }
  const updateChannel = resolveRegistryUpdateChannel({
    configChannel: normalizeUpdateChannel(params.config.update?.channel),
    currentVersion: VERSION,
  });
  if (updateChannel !== "beta") {
    return null;
  }
  const specs =
    request.source === "clawhub"
      ? resolveClawHubInstallSpecsForUpdateChannel({ spec: request.spec, updateChannel })
      : resolveNpmInstallSpecsForUpdateChannel({ spec: request.spec, updateChannel });
  return specs.installSpec === request.spec ? null : specs.installSpec;
}

type ManagedPluginSourceInstallParams = {
  request: ManagedPluginSourceInstallRequest;
  snapshot: ConfigSnapshotForInstallPersist;
  env?: NodeJS.ProcessEnv;
  logger?: PluginInstallLogger & { terminalLinks?: boolean };
  safetyOverrides?: InstallSafetyOverrides;
  runtime?: RuntimeEnv;
  invalidateRuntimeCache?: boolean;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
};

/**
 * Installs official plugins from the release stream the gateway runs. When that
 * stream has no published artifact the install reports it instead of widening
 * back to the registry default: widening would resolve `latest` and land exactly
 * the cross-release plugin this boundary exists to prevent, and a fresh install
 * has nothing to preserve, so failing with the reason costs the operator only a
 * retry with an explicit version.
 */
export async function installManagedPluginSource(
  params: ManagedPluginSourceInstallParams,
): Promise<ManagedPluginSourceInstallResult> {
  const { request } = params;
  if (request.source !== "official" && request.source !== "npm" && request.source !== "clawhub") {
    return await installResolvedManagedPluginSource(params);
  }
  const installSpec = resolveOfficialManagedInstallSpec({
    request,
    config: params.snapshot.config,
  });
  if (!installSpec) {
    return await installResolvedManagedPluginSource(params);
  }
  const result = await installResolvedManagedPluginSource({
    ...params,
    request: { ...request, spec: installSpec, recordSpec: request.recordSpec ?? request.spec },
  });
  if (result.ok) {
    return result;
  }
  const isUnavailableTarget =
    request.source === "clawhub"
      ? isUnavailableClawHubTarget(result)
      : isUnavailableNpmTarget(result);
  if (!isUnavailableTarget) {
    return result;
  }
  return {
    ...result,
    code: PLUGIN_INSTALL_ERROR_CODE.RELEASE_COHORT_UNAVAILABLE,
    error: `No ${installSpec} release is published for this gateway. Installing ${request.spec} would resolve a build from another release; pass an explicit version to install one anyway.`,
  };
}

/** Execute one resolved plugin source through the shared install-and-persist pipeline. */
async function installResolvedManagedPluginSource(
  params: ManagedPluginSourceInstallParams,
): Promise<ManagedPluginSourceInstallResult> {
  const { request } = params;
  const env = params.env ?? process.env;
  const extensionsDir = resolveDefaultPluginExtensionsDir(env);
  if (request.source === "bundled") {
    const result = await installBundledPluginSource({
      snapshot: params.snapshot,
      rawSpec: request.rawSpec,
      bundledSource: request.bundledSource,
      warning: request.warning,
      invalidateRuntimeCache: params.invalidateRuntimeCache,
      runtime: params.runtime,
    });
    return {
      ok: true,
      ...result,
      config: params.snapshot.config,
    };
  }

  const consentExemptSource = request.source === "local" && request.bundledOrigin === true;
  const source =
    request.source === "local"
      ? request.recordSource
      : request.source === "npm-pack" || request.source === "official"
        ? "npm"
        : request.source;
  const capabilityConsent = consentExemptSource
    ? undefined
    : await prepareManagedPluginArtifactConsentHandler({
        config: params.snapshot.config,
        env,
        source,
        ...(request.source === "marketplace"
          ? { spec: `${request.plugin}@${request.marketplace}` }
          : "spec" in request
            ? { spec: request.spec }
            : {}),
        ...("expectedIntegrity" in request && request.expectedIntegrity
          ? { expectedIntegrity: request.expectedIntegrity }
          : {}),
        acknowledgeCapabilities: params.acknowledgeCapabilities,
        onCapabilityConsent: params.onCapabilityConsent,
      });

  const common = requestDeferredPluginInstall({
    ...params.safetyOverrides,
    config: params.snapshot.config,
    extensionsDir,
    logger: params.logger,
    ...(capabilityConsent
      ? { onBeforePluginArtifactCommit: capabilityConsent.onBeforePluginArtifactCommit }
      : {}),
  });
  const complete = async <T extends SourceInstallerResult>(
    installResult: Promise<T>,
    completed: {
      install: (result: Extract<T, { ok: true }>) => PluginInstallRecord;
      expectedPluginId?: string;
      snapshot?: ConfigSnapshotForInstallPersist;
      successMessage?: string;
    },
  ): Promise<ManagedPluginSourceInstallResult> => {
    const result = await installResult;
    if (!result.ok) {
      return result;
    }
    const installed = result as Extract<T, { ok: true }> & {
      pluginId: string;
      targetDir: string;
    };
    // Linking skips the installer's staging transaction but still grants durable authority.
    if (request.source === "local" && request.link) {
      await capabilityConsent?.onBeforePluginArtifactCommit({
        pluginId: installed.pluginId,
        stagedArtifactDir: request.path,
        mode: request.mode ?? "install",
      });
    }
    const transaction = resolvePluginInstallTransaction(installed);
    if (completed.expectedPluginId && installed.pluginId !== completed.expectedPluginId) {
      await transaction?.rollback();
      return {
        ok: false as const,
        error: `official catalog plugin id mismatch: expected ${completed.expectedPluginId}, got ${installed.pluginId}`,
      };
    }
    const persisted = await persistManagedSourceInstall({
      ...params,
      snapshot: completed.snapshot ?? params.snapshot,
      pluginId: installed.pluginId,
      install: capabilityConsent
        ? capabilityConsent.applyAcceptedSurface(installed.pluginId, completed.install(installed))
        : completed.install(installed),
      transaction,
      successMessage: completed.successMessage,
    });
    return {
      ...installed,
      config: persisted.config,
      ...(persisted.warnings.length > 0 ? { warnings: [...new Set(persisted.warnings)] } : {}),
    };
  };

  if (request.source === "local") {
    const installPath = request.link ? request.path : undefined;
    const linkedSnapshot = request.link
      ? {
          ...params.snapshot,
          config: {
            ...params.snapshot.config,
            plugins: {
              ...params.snapshot.config.plugins,
              load: {
                ...params.snapshot.config.plugins?.load,
                paths: uniqueStrings([
                  ...(params.snapshot.config.plugins?.load?.paths ?? []),
                  request.path,
                ]),
              },
            },
          },
        }
      : params.snapshot;
    return await complete(
      installPluginFromPath({
        ...common,
        path: request.path,
        mode: request.mode,
        ...(request.link ? { dryRun: true, allowSourceTypeScriptEntries: true } : {}),
      }),
      {
        snapshot: linkedSnapshot,
        successMessage: request.successMessage,
        install: (result) => ({
          source: request.recordSource,
          sourcePath: request.path,
          installPath: installPath ?? result.targetDir,
          version: result.version,
        }),
      },
    );
  }

  if (request.source === "marketplace") {
    return await complete(
      installPluginFromMarketplace({
        ...common,
        marketplace: request.marketplace,
        plugin: request.plugin,
        mode: request.mode,
      }),
      {
        install: (result) => ({
          source: "marketplace",
          installPath: result.targetDir,
          version: result.version,
          marketplaceName: result.marketplaceName,
          marketplaceSource: result.marketplaceSource,
          marketplacePlugin: result.marketplacePlugin,
        }),
      },
    );
  }

  if (request.source === "npm-pack") {
    return await complete(
      installPluginFromNpmPackArchive({
        ...common,
        archivePath: request.archivePath,
        mode: request.mode,
      }),
      {
        install: (result) => ({
          source: "npm",
          spec: result.npmResolution?.resolvedSpec ?? result.manifestName ?? result.pluginId,
          sourcePath: request.archivePath,
          installPath: result.targetDir,
          ...(result.version ? { version: result.version } : {}),
          ...buildNpmResolutionFields(result.npmResolution),
          artifactKind: "npm-pack",
          artifactFormat: "tgz",
          ...(result.npmResolution?.integrity
            ? { npmIntegrity: result.npmResolution.integrity }
            : {}),
          ...(result.npmResolution?.shasum ? { npmShasum: result.npmResolution.shasum } : {}),
          ...(result.npmTarballName ? { npmTarballName: result.npmTarballName } : {}),
        }),
      },
    );
  }

  if (request.source === "git") {
    return await complete(
      installPluginFromGitSpec({ ...common, spec: request.spec, mode: request.mode }),
      {
        install: (result) => ({
          source: "git",
          spec: request.spec,
          installPath: result.targetDir,
          version: result.version,
          resolvedAt: result.git.resolvedAt,
          gitUrl: result.git.url,
          gitRef: result.git.ref,
          gitCommit: result.git.commit,
        }),
      },
    );
  }

  if (request.source === "clawhub") {
    return await complete(
      installPluginFromClawHub({
        ...common,
        spec: request.spec,
        mode: request.mode,
        ...(request.expectedPluginId ? { expectedPluginId: request.expectedPluginId } : {}),
        ...(request.expectedIntegrity ? { expectedIntegrity: request.expectedIntegrity } : {}),
        ...(request.confirmInstall ? { confirmInstall: request.confirmInstall } : {}),
      }),
      {
        expectedPluginId: request.expectedPluginId,
        install: (result) => ({
          ...buildClawHubPluginInstallRecordFields(result.clawhub),
          spec: request.recordSpec ?? request.spec,
          installPath: result.targetDir,
        }),
      },
    );
  }

  const expectedPluginId =
    request.source === "official" ? request.pluginId : request.expectedPluginId;
  return await complete(
    installPluginFromNpmSpec({
      ...common,
      spec: request.spec,
      mode: request.mode,
      ...(request.source === "official" || request.trustedSourceLinkedOfficialInstall
        ? { trustedSourceLinkedOfficialInstall: true }
        : {}),
      ...(expectedPluginId ? { expectedPluginId } : {}),
      ...(request.expectedIntegrity ? { expectedIntegrity: request.expectedIntegrity } : {}),
    }),
    {
      expectedPluginId,
      install: (result) => ({
        source: "npm",
        spec: request.pin
          ? (result.npmResolution?.resolvedSpec ?? request.spec)
          : (request.recordSpec ?? request.spec),
        installPath: result.targetDir,
        ...(result.version ? { version: result.version } : {}),
        ...buildNpmResolutionFields(result.npmResolution),
      }),
    },
  );
}

function resolveManagedClawHubInstallRequest(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "clawhub" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
  expectedIntegrity?: string;
}): Extract<ManagedPluginSourceInstallRequest, { source: "clawhub" }> {
  const packageName = params.request.packageName.trim();
  const official = resolveOfficialEntryByClawHubPackage(params.officialEntries, packageName);
  // Pin the runtime id only when the catalog entry declares one; the entry-id
  // fallback is just the package name and would reject legitimate installs.
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
  const version =
    params.request.version ?? (requestMatchesHostedCandidate ? hostedClawHub?.version : undefined);
  const expectedIntegrity =
    params.expectedIntegrity ??
    (requestMatchesHostedCandidate ? hostedInstall?.expectedIntegrity : undefined);
  return {
    source: "clawhub",
    spec: buildClawHubSpec(packageName, version),
    ...(official ? { trustedSourceLinkedOfficialInstall: true } : {}),
    ...(expectedPluginId ? { expectedPluginId } : {}),
    ...(expectedIntegrity ? { expectedIntegrity } : {}),
  };
}

function resolveManagedOfficialInstallRequest(params: {
  request: Extract<ManagedPluginInstallRequest, { source: "official" }>;
  officialEntries: readonly OfficialExternalPluginCatalogEntry[];
}): ManagedPluginSourceInstallRequest {
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
    return resolveManagedClawHubInstallRequest({
      request: {
        source: "clawhub",
        packageName: clawhub.name,
        ...(clawhub.version ? { version: clawhub.version } : {}),
      },
      officialEntries: params.officialEntries,
      ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
    });
  }
  if (!install.npmSpec) {
    throw new ManagedPluginLifecycleError(
      `official plugin catalog entry has no supported install source: ${params.request.pluginId}`,
    );
  }
  return {
    source: "official",
    spec: install.npmSpec,
    pluginId,
    mode: "install",
    ...(install.expectedIntegrity ? { expectedIntegrity: install.expectedIntegrity } : {}),
  };
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
    const installLogger = createInstallLogger(warnings);
    const request =
      params.request.source === "clawhub"
        ? resolveManagedClawHubInstallRequest({
            request: params.request,
            officialEntries: officialCatalog.entries,
          })
        : resolveManagedOfficialInstallRequest({
            request: params.request,
            officialEntries: officialCatalog.entries,
          });
    const installed = await installManagedPluginSource({
      request,
      snapshot,
      env,
      logger: installLogger,
      ...(params.request.acknowledgeCapabilities
        ? { acknowledgeCapabilities: params.request.acknowledgeCapabilities }
        : {}),
      ...(params.request.acknowledgeInstallPolicyWarning
        ? {
            safetyOverrides: {
              onInstallPolicyWarning: async () => ({ status: "approved" as const }),
            },
          }
        : {}),
      invalidateRuntimeCache: false,
      runtime: createSilentRuntime(),
    });
    if (!installed.ok) {
      return throwInstallFailure(installed);
    }
    warnings.push(...(installed.warnings ?? []));
    const workspace = resolvePluginControlPlaneWorkspace({ config: installed.config, env });
    if (workspace.diagnostic) {
      warnings.push(workspace.diagnostic.message);
    }
    const catalog = await listManagedPlugins({
      config: installed.config,
      env,
      officialCatalog,
    });
    const installedMetadata = resolvePluginMetadataSnapshot(
      resolveManagedPluginMetadataParams(installed.config, env),
    );
    const installedOwnership = resolveInstalledPluginPackageOwnership(
      installedMetadata.index,
      installed.pluginId,
      env,
    );
    if (!installedOwnership.ok) {
      throw new ManagedPluginLifecycleError(installedOwnership.error);
    }
    const installedPluginIds = installedOwnership.value.pluginIds;
    const representativePluginId = installedPluginIds[0]!;
    const plugin = catalog.plugins.find((entry) => entry.id === representativePluginId);
    if (!plugin) {
      throw new ManagedPluginLifecycleError(
        `installed plugin missing from refreshed registry: ${installed.pluginId}`,
      );
    }
    return {
      plugin,
      ...(installedPluginIds.length > 1 || warnings.length > 0
        ? {
            warnings: [
              ...(installedPluginIds.length > 1
                ? [
                    `Installed package "${installed.pluginId}" with plugin entries: ${installedPluginIds.join(", ")}.`,
                  ]
                : []),
              ...new Set(warnings),
            ],
          }
        : {}),
    };
  });
}

/** Persist desired plugin policy while preserving allow/deny, slot, include, and hash guards. */
export async function setManagedPluginEnabled(params: {
  pluginId: string;
  enabled: boolean;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  env?: NodeJS.ProcessEnv;
}): Promise<{
  plugin: ManagedPluginCatalogEntry;
  changedPaths: string[];
  warnings?: string[];
}> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async () => {
    const snapshot = await readPluginMutationSnapshot(env);
    const metadata = loadPluginMetadataSnapshot(
      resolveManagedPluginMetadataParams(snapshot.config, env),
    );
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    const installedPlugin = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (!installedPlugin) {
      throw new ManagedPluginLifecycleError(`plugin not installed: ${params.pluginId}`);
    }
    if (params.enabled && !installedPlugin.enabled) {
      await resolvePluginCapabilityConsent({
        config: snapshot.config,
        env,
        pluginId,
        acknowledge: params.acknowledgeCapabilities,
        metadata,
      });
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
      env,
      reason: "policy-changed",
      invalidateRuntimeCache: false,
      policyPluginIds: [policyPluginId],
      logger: { warn: (message) => warnings.push(message) },
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
    const installRecords = await loadInstalledPluginIndexInstallRecords({ env });
    // Mirror the CLI uninstall flow: plan against config carrying install records
    // so managed npm/git directories resolve, then persist the stripped config.
    const configWithRecords = withPluginInstallRecords(snapshot.config, installRecords);
    const metadata = loadPluginMetadataSnapshot(
      resolveManagedPluginMetadataParams(configWithRecords, env),
    );
    const pluginId = metadata.normalizePluginId(params.pluginId.trim());
    const record = metadata.index.plugins.find((plugin) => plugin.pluginId === pluginId);
    if (record?.origin === "bundled") {
      throw new ManagedPluginLifecycleError(
        `bundled plugin cannot be uninstalled: ${pluginId}; disable it instead`,
      );
    }
    if (!record && !Object.hasOwn(installRecords, pluginId)) {
      throw new ManagedPluginLifecycleError(`Plugin not found: ${pluginId}`);
    }
    const ownership = resolveInstalledPluginPackageOwnership(metadata.index, pluginId, env);
    if (!ownership.ok) {
      throw new ManagedPluginLifecycleError(ownership.error);
    }
    const { installOwner, pluginIds: ownedPluginIds } = ownership.value;
    const ownedManifests = ownedPluginIds.flatMap((entryId) => {
      const manifest = metadata.byPluginId.get(entryId);
      return manifest ? [manifest] : [];
    });
    const channelIds =
      ownedManifests.length > 0
        ? uniqueStrings(ownedManifests.flatMap((manifest) => manifest.channels))
        : undefined;
    const extensionsDir = resolveDefaultPluginExtensionsDir(env);
    const initialPlan = planPluginUninstall(
      recordPluginPackageUninstallPlan(
        {
          config: configWithRecords,
          pluginId: installOwner,
          ...(channelIds !== undefined ? { channelIds } : {}),
          deleteFiles: true,
          extensionsDir,
        },
        {
          runtimePluginIds: ownedPluginIds,
          runtimeLoadPaths: ownedPluginIds.flatMap(
            (entryId) => metadata.byPluginId.get(entryId)?.source ?? [],
          ),
        },
      ),
    );
    if (!initialPlan.ok) {
      throw new ManagedPluginLifecycleError(initialPlan.error);
    }
    let plan = initialPlan;
    let finalSnapshot = snapshot;
    let directoryResult = { directoryRemoved: false, warnings: [] as string[] };
    if (plan.directoryRemoval) {
      const disabledConfig = prepareConfigForPendingPluginDirectoryRemovalSet(
        snapshot.config,
        ownedPluginIds,
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
      const refreshedPlan = planPluginUninstall(
        recordPluginPackageUninstallPlan(
          {
            config: refreshedConfigWithRecords,
            pluginId: installOwner,
            ...(channelIds !== undefined ? { channelIds } : {}),
            deleteFiles: true,
            extensionsDir,
          },
          {
            runtimePluginIds: ownedPluginIds,
            runtimeLoadPaths: ownedPluginIds.flatMap(
              (entryId) => metadata.byPluginId.get(entryId)?.source ?? [],
            ),
          },
        ),
      );
      if (!refreshedPlan.ok) {
        throw new ManagedPluginLifecycleError(refreshedPlan.error);
      }
      plan = refreshedPlan;
    }
    const nextConfig = withoutPluginInstallRecords(plan.config);
    const nextInstallRecords = removePluginInstallRecordFromRecords(installRecords, installOwner);
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: installRecords,
      nextInstallRecords,
      nextConfig,
      baseHash: finalSnapshot.baseHash,
      writeOptions: finalSnapshot.writeOptions,
    });
    const warnings = [
      ...collectClawPluginUninstallWarnings({
        pluginId: installOwner,
        installRecord: installRecords[installOwner],
        env,
      }),
      ...(pluginId !== installOwner || ownedPluginIds.length > 1
        ? [
            `Uninstalled package "${installOwner}" and all owned plugin entries: ${ownedPluginIds.join(", ")}.`,
          ]
        : []),
      ...directoryResult.warnings,
    ];
    await refreshPluginRegistryAfterConfigMutation({
      config: nextConfig,
      env,
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
      pluginId: installOwner,
      removed,
      ...(warnings.length > 0 ? { warnings: [...new Set(warnings)] } : {}),
    };
  });
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

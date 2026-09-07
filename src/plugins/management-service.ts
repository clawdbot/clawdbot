// Reads plugin inventory and inspection metadata without loading install orchestration.
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type {
  PluginInspectSource,
  PluginsInspectResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { resolveConfigWidePluginMetadataSnapshot } from "../config/io.plugin-metadata.js";
import { resolveIsConfigReadOnly } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePendingPluginCapabilityReview } from "./capability-consent.js";
import {
  buildPluginCapabilitySummary,
  computeDeclaredSurfaceHash,
  formatPluginCapabilityConsentRequired,
  resolveAcceptedSurfaceCurrent,
  resolvePluginInstallRecordIntegrity,
  resolvePluginInstallRecordTrust,
  resolvePluginPackageDeclaredSurface,
} from "./capability-summary.js";
import {
  appendPluginControlPlaneWorkspaceDiagnostic,
  resolvePluginControlPlaneWorkspace,
} from "./control-plane-workspace.js";
import { getProcessGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import {
  createInstalledPluginEnabledPredicate,
  isInstalledPluginEnabled,
} from "./installed-plugin-index.js";
import { createInstalledPluginOwnershipResolver } from "./installed-plugin-package-ownership.js";
import {
  type ManagedPluginCatalogEntry,
  type ManagedPluginCatalog,
  type OfficialCatalogResult,
  getManagedPluginCache,
  withManagedPluginCache,
  prepareCatalogEntry,
  prepareCatalogEntries,
  loadOfficialCatalog,
  normalizeKinds,
  normalizeCatalogMetadata,
  normalizeFeaturedAt,
  derivePluginCategory,
  firstPluginError,
  compareCatalogEntries,
  resolveInstalledPluginPresentation,
  resolveInstalledHostedOfficialEntry,
  resolveOfficialEntryById,
} from "./management-catalog.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import type { PluginDiagnostic } from "./manifest-types.js";
import {
  getOfficialExternalPluginCatalogManifest,
  listOfficialExternalPluginCatalogEntries,
  resolveOfficialExternalPluginId,
  resolveOfficialExternalPluginLabel,
} from "./official-external-plugin-catalog.js";
import { tracksPluginDependencyStatus } from "./official-external-plugin-repair-hints.js";
import { createPluginCache, getProcessPluginCache, withPluginCache } from "./plugin-cache.js";
import {
  loadPluginMetadataSnapshot,
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";
import { resolveManifestProviderAuthChoices } from "./provider-auth-choices.js";
import { listRecommendedToolInstalls } from "./recommended-tool-installs.js";
import {
  buildPluginDependencyStatus,
  projectPluginDependencyHealth,
} from "./status-dependencies-core.js";

export type ManagedPluginInspection = PluginsInspectResult;

function resolveManagedPluginDiagnostics(
  snapshot: PluginMetadataSnapshot,
  config: OpenClawConfig,
): PluginDiagnostic[] {
  const dependencies = getManagedPluginCache().dependencyStatus;
  const isEnabled = createInstalledPluginEnabledPredicate(snapshot.index.plugins, config);
  const { diagnostics } = projectPluginDependencyHealth({
    plugins: snapshot.index.plugins.map((record) => {
      const manifest = snapshot.byPluginId.get(record.pluginId);
      const enabled = isEnabled(record.pluginId);
      if (manifest && !dependencies.has(manifest) && tracksPluginDependencyStatus(record)) {
        dependencies.set(
          manifest,
          buildPluginDependencyStatus({
            rootDir: record.rootDir,
            dependencies: manifest.packageDependencies,
            optionalDependencies: manifest.packageOptionalDependencies,
          }),
        );
      }
      return {
        id: record.pluginId,
        source: manifest?.source ?? record.source ?? record.manifestPath,
        enabled,
        status: enabled ? ("loaded" as const) : ("disabled" as const),
        dependencyStatus: manifest ? dependencies.get(manifest) : undefined,
      };
    }),
    diagnostics: [...snapshot.diagnostics],
  });
  return diagnostics;
}

export type ManagedPluginIconSource = { kind: "file"; path: string; rootPath: string };

function resolvePluginIconSource(params: {
  metadata: PluginMetadataSnapshot;
  pluginId: string;
}): ManagedPluginIconSource | undefined {
  const normalizedPluginId = params.metadata.normalizePluginId(params.pluginId);
  const manifest = params.metadata.byPluginId.get(normalizedPluginId);
  const localIconPath = normalizeOptionalString(manifest?.iconPath);
  if (localIconPath && manifest) {
    return { kind: "file", path: localIconPath, rootPath: manifest.rootDir };
  }
  return undefined;
}
function resolveManagedPluginMetadataParams(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  const workspace = resolvePluginControlPlaneWorkspace({ config, env });
  return {
    config,
    env,
    ...(workspace.workspaceDir !== undefined ? { workspaceDir: workspace.workspaceDir } : {}),
  };
}

function resolveManagedPluginMetadata(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  const boot = getProcessGatewayPluginMetadataSnapshot();
  const candidate = getProcessPluginCache().desiredMetadata;
  return candidate && candidate.boot === boot
    ? candidate.snapshot
    : resolvePluginMetadataSnapshot(resolveManagedPluginMetadataParams(config, env));
}

export function loadFreshManagedPluginMetadata(config: OpenClawConfig, env: NodeJS.ProcessEnv) {
  // Gateway actions must cover every workspace shown in its management inventory.
  return getProcessGatewayPluginMetadataSnapshot()
    ? resolveConfigWidePluginMetadataSnapshot({ config, env, allowCurrent: false })
    : loadPluginMetadataSnapshot({
        ...resolveManagedPluginMetadataParams(config, env),
        allowCurrent: false,
      });
}

/** Publish desired install state for management without replacing the Gateway's boot facts. */
export function refreshManagedPluginMetadata(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): PluginMetadataSnapshot {
  const env = params.env ?? process.env;
  const boot = getProcessGatewayPluginMetadataSnapshot();
  // Install writes may have replaced package bytes already seen by the operation.
  // Publish only a completely prepared generation; retained readers keep their original facts.
  const cache = createPluginCache();
  const snapshot = withPluginCache(cache, () => loadFreshManagedPluginMetadata(params.config, env));
  if (boot) {
    getProcessPluginCache().desiredMetadata = { boot, cache, snapshot };
  }
  return snapshot;
}

/** Resolve the current package-local icon without accepting caller-provided input. */
export const resolveManagedPluginIconSource = withManagedPluginCache(
  async (params: {
    config: OpenClawConfig;
    pluginId: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ManagedPluginIconSource | undefined> => {
    const env = params.env ?? process.env;
    const metadata = resolveManagedPluginMetadata(params.config, env);
    return resolvePluginIconSource({ metadata, pluginId: params.pluginId });
  },
);

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
export const listManagedPlugins = withManagedPluginCache(
  async (params: {
    config: OpenClawConfig;
    env?: NodeJS.ProcessEnv;
    officialCatalog?: OfficialCatalogResult;
    metadata?: PluginMetadataSnapshot;
  }): Promise<ManagedPluginCatalog> => {
    const env = params.env ?? process.env;
    const workspace = resolvePluginControlPlaneWorkspace({ config: params.config, env });
    const metadata = params.metadata ?? resolveManagedPluginMetadata(params.config, env);
    const pluginDiagnostics = resolveManagedPluginDiagnostics(metadata, params.config);
    const officialCatalog = params.officialCatalog ?? (await loadOfficialCatalog());
    // Prepare the merged entry once; display names never add install identities.
    const officialEntries = prepareCatalogEntries(officialCatalog.entries);
    const bundledOfficialEntries = prepareCatalogEntries(
      listOfficialExternalPluginCatalogEntries(),
    );
    const installedIconsById = new Map<string, ManagedPluginIconSource | undefined>();
    const installedClawHubPackages = new Set<string>();
    const capabilityConsentDiagnostics: PluginDiagnostic[] = [];
    // Hosted loading can yield; prepare this phase from the current config.
    const isEnabled = createInstalledPluginEnabledPredicate(
      metadata.index.plugins,
      params.config,
      env,
    );
    const ownershipResolver = createInstalledPluginOwnershipResolver(metadata.index);
    const plugins = metadata.index.plugins.map((record): ManagedPluginCatalogEntry => {
      const enabled = isEnabled(record.pluginId);
      const manifest = metadata.byPluginId.get(record.pluginId);
      const localCatalog = normalizeCatalogMetadata(manifest?.catalog);
      const ownership = ownershipResolver.resolvePackage(record.pluginId);
      const installOwner = ownership.ok ? ownership.value.installOwner : undefined;
      const installRecord = installOwner ? metadata.index.installRecords[installOwner] : undefined;
      if (
        enabled &&
        record.origin !== "bundled" &&
        !manifest?.trustedOfficialInstall &&
        ownership.ok &&
        installRecord
      ) {
        const declared = resolvePluginPackageDeclaredSurface(ownership.value, metadata.byPluginId);
        if (!declared || !resolveAcceptedSurfaceCurrent(installRecord, declared)) {
          capabilityConsentDiagnostics.push({
            level: "warn",
            pluginId: record.pluginId,
            message: formatPluginCapabilityConsentRequired(record.pluginId),
          });
        }
      }
      const { entry: officialEntry, clawhubPackage } = resolveInstalledHostedOfficialEntry({
        record,
        ...(installOwner ? { installOwner } : {}),
        installRecord,
        officialEntries,
        bundledOfficialEntries,
      });
      // A declared counterpart suppresses the same ClawHub package, not an npm namesake.
      if (clawhubPackage) {
        installedClawHubPackages.add(clawhubPackage);
      }
      const officialCatalogMetadata = officialEntry
        ? normalizeCatalogMetadata(getOfficialExternalPluginCatalogManifest(officialEntry)?.catalog)
        : undefined;
      // Published plugin curation follows the live feed even after install, including
      // omission. Private bundled plugins without an exact package/source match stay local.
      const catalog =
        clawhubPackage && officialCatalog.hostedFeaturedAuthoritative
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
        Boolean(clawhubPackage) && officialCatalog.hostedFeaturedAuthoritative === true;
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
        enabled,
        state: error ? "error" : enabled ? "enabled" : "disabled",
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
      const normalizedPluginId = metadata.normalizePluginId(record.pluginId);
      // Icon lookup uses the first normalized record, even when that record has no icon.
      if (!installedIconsById.has(normalizedPluginId)) {
        installedIconsById.set(
          normalizedPluginId,
          resolvePluginIconSource({ metadata, pluginId: record.pluginId }),
        );
      }
      if (installedIconsById.get(normalizedPluginId)) {
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
    for (const facts of officialEntries()) {
      const { entry, clawhub, npmPackage } = facts;
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
      if (
        !pluginId ||
        !catalog ||
        installedIds.has(pluginId) ||
        (clawhub &&
          (installedPackageNames.has(clawhub.name) ||
            installedClawHubPackages.has(clawhub.name))) ||
        (npmPackage && installedPackageNames.has(npmPackage))
      ) {
        continue;
      }
      const kind = normalizeKinds(entry.kind);
      const install: ManagedPluginCatalogEntry["install"] =
        facts.selectedSource?.source === "clawhub" && clawhub && !clawhub.version
          ? { source: "clawhub", packageName: clawhub.name }
          : facts.install
            ? { source: "official", pluginId }
            : undefined;
      const packageName = npmPackage ?? clawhub?.name;
      const description = normalizeOptionalString(entry.description);
      const version = normalizeOptionalString(entry.version);
      const featuredAt =
        catalog.featured === true ? normalizeFeaturedAt(entry.featuredAt) : undefined;
      plugins.push({
        id: pluginId,
        name: resolveOfficialExternalPluginLabel(entry),
        ...(packageName ? { packageName } : {}),
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
        ...(install ? { install } : {}),
      });
    }
    const diagnostics: unknown[] = getProcessGatewayPluginMetadataSnapshot()
      ? [...pluginDiagnostics, ...capabilityConsentDiagnostics]
      : appendPluginControlPlaneWorkspaceDiagnostic(
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
      mutationAllowed: !resolveIsConfigReadOnly(env),
    };
  },
);

/** Inspect one plugin's manifest, operator grants, and recorded install provenance. */
export const inspectManagedPlugin = withManagedPluginCache(
  async (params: {
    config: OpenClawConfig;
    pluginId: string;
    env?: NodeJS.ProcessEnv;
  }): Promise<ManagedPluginInspection> => {
    const env = params.env ?? process.env;
    const metadata = resolveManagedPluginMetadata(params.config, env);
    const pluginId = metadata.normalizePluginId(params.pluginId);
    const record = metadata.index.plugins.find((candidate) => candidate.pluginId === pluginId);
    const enabled = isInstalledPluginEnabled(metadata.index, pluginId, params.config);
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
          enabled,
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
      const ownership = createInstalledPluginOwnershipResolver(metadata.index, env).resolvePackage(
        pluginId,
      );
      const installOwner = ownership.ok ? ownership.value.installOwner : undefined;
      const installRecord = installOwner ? metadata.index.installRecords[installOwner] : undefined;
      const { entry: officialEntry, clawhubPackage } = resolveInstalledHostedOfficialEntry({
        record,
        ...(installOwner ? { installOwner } : {}),
        installRecord,
        officialEntries: prepareCatalogEntries(officialCatalog.entries),
        bundledOfficialEntries: prepareCatalogEntries(listOfficialExternalPluginCatalogEntries()),
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
              Boolean(clawhubPackage) && officialCatalog.hostedFeaturedAuthoritative === true,
          }),
          origin: record.origin,
          installed: true,
          enabled,
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
    const { selectedSource, clawhub, npmPackage } = prepareCatalogEntry(entry);
    const packageName = npmPackage ?? clawhub?.name;
    const spec = selectedSource?.spec;
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
        ...(selectedSource?.expectedIntegrity
          ? {
              integrity: selectedSource.expectedIntegrity,
              integrityKind: selectedSource.source === "clawhub" ? "sha256" : "ssri",
            }
          : {}),
      },
      ...summary,
      reviewToken: computeDeclaredSurfaceHash(summary.declared),
    };
  },
);

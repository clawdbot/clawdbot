import fs from "node:fs";
import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { PLUGIN_DECLARED_SURFACE_GROUPS } from "../../packages/gateway-protocol/src/schema/plugin-declared-surface-groups.js";
import type {
  PluginInstallTrust,
  PluginsInspectResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginAcceptedDeclaredSurface,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import { isRootFileMissingFailure } from "../infra/boundary-file-read.js";
import {
  resolvePathViaExistingAncestorSync,
  resolveRootPathSync,
  safeRealpathSync,
} from "../infra/boundary-path.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolveUserPath } from "../utils.js";
import {
  buildPluginCapabilitySummary,
  computeDeclaredSurfaceHash,
  mergePluginDeclaredSurfaces,
  resolveAcceptedSurfaceCurrent,
  resolvePluginInstallRecordIntegrity,
  resolvePluginPackageDeclaredSurface,
} from "./capability-summary.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";
import { discoverConfiguredPluginLoadPaths } from "./discovery.js";
import type {
  PluginInstallArtifactConsentHandler,
  PluginInstallArtifactConsentRequest,
} from "./install-types.js";
import {
  isInstalledPluginIndexInstallOwnerAmbiguous,
  resolveInstalledPluginIndexInstallOwner,
} from "./installed-plugin-index-install-owner.js";
import {
  loadInstalledPluginIndexInstallRecords,
  writePersistedInstalledPluginIndexInstallRecordsWithLease,
} from "./installed-plugin-index-records.js";
import type { InstalledPluginInstallRecordInfo } from "./installed-plugin-index-types.js";
import { resolveInstalledPluginPackageOwnership } from "./installed-plugin-package-ownership.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import { loadPluginManifestRegistryCore } from "./manifest-registry.js";
import { resolvePackageExtensionEntries } from "./package-manifest.js";
import { createPluginCache, withPluginCache } from "./plugin-cache.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";

type PluginArtifactInspectionContext = {
  config?: OpenClawConfig;
  currentArtifactDir?: string;
};

function resolvePluginArtifactManifests(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
  context: PluginArtifactInspectionContext = {},
) {
  const artifactRoot = fs.realpathSync(resolveUserPath(rootDir, env));
  const packageManifest = readRootJsonObjectSync({
    rootDir: artifactRoot,
    rootRealPath: artifactRoot,
    relativePath: "package.json",
    boundaryLabel: "plugin artifact directory",
    rejectHardlinks: true,
  });
  if (!packageManifest.ok) {
    if (packageManifest.reason !== "open" || !isRootFileMissingFailure(packageManifest.failure)) {
      throw new Error(`Unable to inspect the plugin artifact package manifest: ${artifactRoot}`);
    }
  } else {
    const extensions = resolvePackageExtensionEntries(packageManifest.value);
    if (extensions.status === "invalid") {
      throw new Error(extensions.error);
    }
    if (extensions.status === "empty") {
      throw new Error("package.json openclaw.extensions is empty");
    }
  }

  const currentRoot = path.resolve(resolveUserPath(context.currentArtifactDir ?? rootDir, env));
  const currentCanonicalRoot = resolvePathViaExistingAncestorSync(currentRoot);
  const loadPaths: string[] = [];
  for (const configuredPath of context.config?.plugins?.load?.paths ?? []) {
    const source = path.resolve(resolveUserPath(configuredPath, env));
    const canonicalSource = resolvePathViaExistingAncestorSync(source);
    if (
      !isPathInside(currentRoot, source) &&
      !isPathInside(currentCanonicalRoot, canonicalSource)
    ) {
      continue;
    }
    const current = resolveRootPathSync({
      absolutePath: source,
      rootPath: currentRoot,
      rootCanonicalPath: currentCanonicalRoot,
      boundaryLabel: "installed plugin artifact directory",
    });
    const lexicalRoot = isPathInside(currentRoot, source) ? currentRoot : currentCanonicalRoot;
    const relativePath = isPathInside(lexicalRoot, source)
      ? path.relative(lexicalRoot, source)
      : path.relative(
          currentCanonicalRoot,
          current.kind === "directory"
            ? current.canonicalPath
            : path.join(
                resolvePathViaExistingAncestorSync(path.dirname(source)),
                path.basename(source),
              ),
        );
    const staged = resolveRootPathSync({
      absolutePath: path.join(artifactRoot, relativePath),
      rootPath: artifactRoot,
      rootCanonicalPath: artifactRoot,
      boundaryLabel: "staged plugin artifact directory",
    });
    // A file symlink uses its lexical parent's manifest, not the target file's parent.
    loadPaths.push(staged.absolutePath);
  }
  // Explicit paths keep runtime precedence; ordinary package entries all use their root manifest.
  loadPaths.push(artifactRoot);
  const packageDiscovery = discoverConfiguredPluginLoadPaths({
    loadPaths: [artifactRoot],
    env,
    deduplicate: true,
  });
  const packageSources = new Set(
    packageDiscovery.candidates.map(
      (candidate) => safeRealpathSync(candidate.source) ?? candidate.source,
    ),
  );
  const discovery =
    loadPaths.length === 1
      ? packageDiscovery
      : discoverConfiguredPluginLoadPaths({ loadPaths, env, deduplicate: true });
  const registry = loadPluginManifestRegistryCore({
    config: { plugins: { load: { paths: loadPaths } } },
    env,
    installRecords: {},
    discovery: {
      // Only physical package entries inherit managed ownership, including configured overrides.
      candidates: discovery.candidates.filter((candidate) =>
        packageSources.has(safeRealpathSync(candidate.source) ?? candidate.source),
      ),
      diagnostics: packageDiscovery.diagnostics,
    },
  });
  const error = registry.diagnostics.find((diagnostic) => diagnostic.level === "error");
  if (error || registry.plugins.length === 0) {
    throw new Error(
      error?.message ?? `Plugin artifact has no valid plugin manifest: ${artifactRoot}`,
    );
  }
  return registry.plugins;
}

function inspectPluginArtifact(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
  context: PluginArtifactInspectionContext = {},
) {
  // Consent inspects the current artifact, including after an approval callback yields.
  // Runtime or earlier review facts must never authorize replacement bytes.
  return withPluginCache(createPluginCache(), () => {
    const manifests = resolvePluginArtifactManifests(rootDir, env, context);
    return {
      manifest: manifests[0],
      declared: mergePluginDeclaredSurfaces(
        manifests.map(
          (manifest) => buildPluginCapabilitySummary({ manifest, origin: "global" }).declared,
        ),
      ),
    };
  });
}

/** Read only validated manifest surfaces belonging to the actual artifact on disk. */
export function resolvePluginArtifactDeclaredSurface(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
  context: PluginArtifactInspectionContext = {},
): PluginAcceptedDeclaredSurface {
  return inspectPluginArtifact(rootDir, env, context).declared;
}

export function diffDeclaredSurfaceWidening(
  previous: PluginAcceptedDeclaredSurface,
  next: PluginAcceptedDeclaredSurface,
): { widened: Partial<PluginAcceptedDeclaredSurface>; hasWidening: boolean } {
  const widened: Partial<PluginAcceptedDeclaredSurface> = {};
  for (const group of PLUGIN_DECLARED_SURFACE_GROUPS) {
    const previousValues = new Set(previous[group]);
    const added = next[group].filter((value) => !previousValues.has(value)).toSorted();
    if (added.length > 0) {
      widened[group] = added;
    }
  }
  return { widened, hasWidening: Object.keys(widened).length > 0 };
}

export type PluginCapabilityConsentAcknowledgment = { reviewToken: string };

export type PluginCapabilityConsentReview = Omit<PluginsInspectResult, "ok" | "plugin"> & {
  pluginId: string;
  name: string;
  version?: string;
  widened?: Partial<PluginAcceptedDeclaredSurface>;
  acceptedAt?: string;
};

export type PluginCapabilityConsentHandler = (
  review: PluginCapabilityConsentReview,
) => Promise<PluginCapabilityConsentAcknowledgment | undefined>;

/** Preserve caller control-flow failures across installers that normalize exceptions. */
export function capturePluginCapabilityConsentHandlerErrors(
  handler: PluginCapabilityConsentHandler | undefined,
): {
  onCapabilityConsent: PluginCapabilityConsentHandler | undefined;
  rethrowCallbackError: () => void;
} {
  let failure: { error: unknown } | undefined;
  return {
    onCapabilityConsent: handler
      ? async (review) => {
          try {
            return await handler(review);
          } catch (error) {
            failure = { error };
            throw error;
          }
        }
      : undefined,
    rethrowCallbackError: () => {
      if (failure) {
        throw failure.error;
      }
    },
  };
}

const pendingPluginCapabilityReviews = new Map<string, PluginCapabilityConsentReview>();

registerPluginMetadataProcessMemoLifecycleClear(() => {
  pendingPluginCapabilityReviews.clear();
});

export function resolvePendingPluginCapabilityReview(
  pluginId: string,
): PluginCapabilityConsentReview | undefined {
  return pendingPluginCapabilityReviews.get(pluginId);
}

export function resolvePluginInstallRecordTrust(
  record: InstalledPluginInstallRecordInfo | undefined,
): PluginInstallTrust | undefined {
  if (!record?.clawhubTrustDisposition) {
    return undefined;
  }
  return {
    disposition: record.clawhubTrustDisposition,
    ...(record.clawhubTrustReasons ? { reasons: [...record.clawhubTrustReasons] } : {}),
    ...(record.clawhubTrustCheckedAt ? { checkedAt: record.clawhubTrustCheckedAt } : {}),
    ...(record.clawhubTrustAcknowledgedAt
      ? { acknowledgedAt: record.clawhubTrustAcknowledgedAt }
      : {}),
    ...(record.clawhubTrustPending !== undefined ? { pending: record.clawhubTrustPending } : {}),
    ...(record.clawhubTrustStale !== undefined ? { stale: record.clawhubTrustStale } : {}),
  };
}

function acceptManagedPluginDeclaredSurface<T extends PluginInstallRecord>(
  record: T,
  declared: PluginAcceptedDeclaredSurface,
): T {
  const integrity = resolvePluginInstallRecordIntegrity(record)?.integrity;
  const accepted = {
    ...record,
    acceptedSurface: declared,
    acceptedSurfaceHash: computeDeclaredSurfaceHash(declared),
    acceptedSurfaceAt: new Date().toISOString(),
  };
  delete accepted.acceptedSurfaceIntegrity;
  if (integrity) {
    accepted.acceptedSurfaceIntegrity = integrity;
  }
  return accepted;
}

export function buildPluginCapabilityConsentReview(params: {
  pluginId: string;
  manifest: Parameters<typeof buildPluginCapabilitySummary>[0]["manifest"] & {
    name?: string;
    version?: string;
  };
  record: PluginInstallRecord;
  config: OpenClawConfig;
  declared?: PluginAcceptedDeclaredSurface;
  previousDeclared?: PluginAcceptedDeclaredSurface;
  widened?: Partial<PluginAcceptedDeclaredSurface>;
}): PluginCapabilityConsentReview {
  const { pluginId, manifest, record } = params;
  const summary = buildPluginCapabilitySummary({
    manifest,
    origin: "global",
    entryConfig: params.config.plugins?.entries?.[pluginId],
  });
  const declared = params.declared ?? summary.declared;
  const spec = record.resolvedSpec ?? record.spec;
  const packageName = record.clawhubPackage ?? record.resolvedName;
  const previousDeclared = params.previousDeclared ?? record.acceptedSurface;
  const widened =
    params.widened ??
    (previousDeclared
      ? diffDeclaredSurfaceWidening(previousDeclared, declared).widened
      : undefined);
  const trust = resolvePluginInstallRecordTrust(record);
  return {
    pluginId,
    name: manifest.name ?? pluginId,
    ...((manifest.version ?? record.version)
      ? { version: manifest.version ?? record.version }
      : {}),
    ...summary,
    declared,
    reviewToken: computeDeclaredSurfaceHash(declared),
    source: {
      kind: record.source,
      // Keep operational specs in install records; prompts and RPCs receive display-safe copies.
      ...(spec ? { spec: redactSensitiveUrlLikeString(spec) } : {}),
      ...(packageName ? { packageName } : {}),
      ...resolvePluginInstallRecordIntegrity(record),
    },
    ...(trust ? { trust } : {}),
    ...(widened && Object.keys(widened).length > 0 ? { widened } : {}),
    ...(record.acceptedSurfaceAt ? { acceptedAt: record.acceptedSurfaceAt } : {}),
  };
}

function throwManagedPluginCapabilityConsentRequired(review: PluginCapabilityConsentReview): never {
  pendingPluginCapabilityReviews.delete(review.pluginId);
  pendingPluginCapabilityReviews.set(review.pluginId, review);
  if (pendingPluginCapabilityReviews.size > 32) {
    const oldest = pendingPluginCapabilityReviews.keys().next().value;
    if (oldest !== undefined) {
      pendingPluginCapabilityReviews.delete(oldest);
    }
  }
  throw new ManagedPluginLifecycleError(
    `Plugin "${review.pluginId}" requires capability consent. Use openclaw plugins install or openclaw plugins enable with --accept-capabilities, then retry.`,
    {
      capabilityConsent: {
        pluginId: review.pluginId,
        reviewToken: review.reviewToken,
        ...(review.widened ? { widened: review.widened } : {}),
        ...(review.acceptedAt ? { acceptedAt: review.acceptedAt } : {}),
      },
    },
  );
}

/** Enforce and durably acknowledge consent before an installed plugin is enabled. */
export async function resolvePluginCapabilityConsent(params: {
  config: OpenClawConfig;
  pluginId: string;
  env?: NodeJS.ProcessEnv;
  acknowledge?: PluginCapabilityConsentAcknowledgment;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  beforePersistentEffect?: () => void | Promise<void>;
  metadata?: PluginMetadataSnapshot;
}): Promise<void> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async (lease) => {
    const workspace = resolvePluginControlPlaneWorkspace({ config: params.config, env });
    const metadata =
      params.metadata ??
      resolvePluginMetadataSnapshot({
        allowCurrent: false,
        config: params.config,
        env,
        ...(workspace.workspaceDir !== undefined ? { workspaceDir: workspace.workspaceDir } : {}),
      });
    const pluginId = metadata.normalizePluginId(params.pluginId);
    const plugin = metadata.index.plugins.find((candidate) => candidate.pluginId === pluginId);
    if (!plugin || plugin.origin === "bundled") {
      return;
    }
    if (
      !resolveInstalledPluginIndexInstallOwner(plugin) &&
      !isInstalledPluginIndexInstallOwnerAmbiguous(plugin) &&
      !Object.hasOwn(metadata.index.installRecords, pluginId)
    ) {
      return;
    }
    const ownership = resolveInstalledPluginPackageOwnership(metadata.index, pluginId, env);
    if (!ownership.ok) {
      throw new ManagedPluginLifecycleError(ownership.error);
    }
    const { installOwner, installRecord } = ownership.value;
    const manifest = metadata.byPluginId.get(pluginId);
    if (!manifest) {
      throw new ManagedPluginLifecycleError(`Plugin "${pluginId}" has no installed manifest.`);
    }
    const declared = resolvePluginPackageDeclaredSurface(ownership.value, metadata.byPluginId);
    if (!declared) {
      throw new ManagedPluginLifecycleError(
        `Plugin package "${installOwner}" has incomplete manifest metadata.`,
      );
    }
    const review = buildPluginCapabilityConsentReview({
      pluginId,
      manifest,
      record: installRecord,
      config: params.config,
      declared,
    });
    if (resolveAcceptedSurfaceCurrent(installRecord, declared)) {
      pendingPluginCapabilityReviews.delete(pluginId);
      return;
    }
    const acknowledgment = params.acknowledge ?? (await params.onCapabilityConsent?.(review));
    if (!acknowledgment) {
      throwManagedPluginCapabilityConsentRequired(review);
    }
    await params.beforePersistentEffect?.();
    const records = await loadInstalledPluginIndexInstallRecords({ env });
    const persistedRecord = records[installOwner];
    if (!persistedRecord?.installPath) {
      throw new ManagedPluginLifecycleError(
        `Plugin "${pluginId}" no longer has a verifiable installed package record.`,
      );
    }
    const currentDeclared = resolvePluginArtifactDeclaredSurface(persistedRecord.installPath, env, {
      config: params.config,
    });
    const currentReview = buildPluginCapabilityConsentReview({
      pluginId,
      manifest,
      record: persistedRecord,
      config: params.config,
      declared: currentDeclared,
    });
    // Consent callbacks yield; reread the artifact surface before recording acceptance.
    if (acknowledgment.reviewToken !== currentReview.reviewToken) {
      throwManagedPluginCapabilityConsentRequired(currentReview);
    }
    await writePersistedInstalledPluginIndexInstallRecordsWithLease(
      {
        ...records,
        [installOwner]: acceptManagedPluginDeclaredSurface(persistedRecord, currentDeclared),
      },
      { env, config: params.config, lease },
    );
    pendingPluginCapabilityReviews.delete(pluginId);
  });
}

async function resolvePluginArtifactCapabilityConsent(params: {
  config: OpenClawConfig;
  pluginId: string;
  record: PluginInstallRecord;
  artifactDir: string;
  currentArtifactDir?: string;
  env?: NodeJS.ProcessEnv;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  beforePersistentEffect?: () => void | Promise<void>;
  previousDeclared?: PluginAcceptedDeclaredSurface;
  previousRecord?: PluginInstallRecord;
  mode?: "install" | "update";
}): Promise<PluginAcceptedDeclaredSurface> {
  const artifactContext = { config: params.config, currentArtifactDir: params.currentArtifactDir };
  const { declared, manifest } = inspectPluginArtifact(
    params.artifactDir,
    params.env,
    artifactContext,
  );
  const review = buildPluginCapabilityConsentReview({
    pluginId: params.pluginId,
    manifest: manifest ?? { name: params.pluginId },
    record: params.record,
    config: params.config,
    declared,
    ...(params.previousDeclared ? { previousDeclared: params.previousDeclared } : {}),
  });
  let acceptanceCurrent = false;
  if (params.mode === "update" && params.previousDeclared) {
    const { hasWidening } = diffDeclaredSurfaceWidening(params.previousDeclared, declared);
    const priorAcceptanceCurrent =
      params.previousRecord !== undefined &&
      resolveAcceptedSurfaceCurrent(params.previousRecord, params.previousDeclared) &&
      resolvePluginInstallRecordIntegrity(params.previousRecord) !== undefined;
    acceptanceCurrent = !hasWidening && priorAcceptanceCurrent;
    // Managed installs activate the package, even when its previous version was disabled.
    // Update-only flows preserve disablement in preparePluginUpdateCapabilityConsent instead.
  }
  const acknowledgment = acceptanceCurrent
    ? { reviewToken: review.reviewToken }
    : (params.acknowledgeCapabilities ?? (await params.onCapabilityConsent?.(review)));
  // Review and staged-package rollback remain cancellable. Lock only when
  // accepting this artifact, then recheck its bytes after the callback yields.
  if (acknowledgment) {
    await params.beforePersistentEffect?.();
  }
  // Interactive consent yields; re-read the final stage so a replaced artifact cannot inherit it.
  const { declared: finalDeclared, manifest: finalManifest } = inspectPluginArtifact(
    params.artifactDir,
    params.env,
    artifactContext,
  );
  const finalToken = computeDeclaredSurfaceHash(finalDeclared);
  if (!acknowledgment || acknowledgment.reviewToken !== finalToken) {
    const finalReview =
      finalToken === review.reviewToken
        ? review
        : buildPluginCapabilityConsentReview({
            pluginId: params.pluginId,
            manifest: finalManifest ?? {
              name: params.pluginId,
            },
            record: params.record,
            config: params.config,
            declared: finalDeclared,
            ...(params.previousDeclared ? { previousDeclared: params.previousDeclared } : {}),
          });
    return throwManagedPluginCapabilityConsentRequired(finalReview);
  }
  pendingPluginCapabilityReviews.delete(params.pluginId);
  return finalDeclared;
}

/** Bind artifact consent to verified staged bytes and carry acceptance into the record commit. */
export function createManagedPluginArtifactConsentHandler(params: {
  config: OpenClawConfig;
  source: PluginInstallRecord["source"];
  env?: NodeJS.ProcessEnv;
  spec?: string;
  expectedIntegrity?: string;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  beforePersistentEffect?: () => void | Promise<void>;
  previousRecords?: Record<string, PluginInstallRecord>;
  previousPluginOwners?: ReadonlyMap<string, string>;
}): {
  onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler;
  applyAcceptedSurface: <T extends PluginInstallRecord>(pluginId: string, record: T) => T;
} {
  const previousDeclaredByOwner = new Map<string, PluginAcceptedDeclaredSurface>();
  for (const [installOwner, record] of Object.entries(params.previousRecords ?? {})) {
    if (record.installPath) {
      try {
        previousDeclaredByOwner.set(
          installOwner,
          resolvePluginArtifactDeclaredSurface(record.installPath, params.env, {
            config: params.config,
          }),
        );
      } catch {
        // Repair may replace a missing or damaged payload. Only a verified prior
        // surface can carry acceptance forward; otherwise require a fresh staged review.
      }
    }
  }
  const pendingAcceptedSurfaces = new Map<string, PluginAcceptedDeclaredSurface>();
  return {
    onBeforePluginArtifactCommit: async (
      artifact: PluginInstallArtifactConsentRequest,
    ): Promise<void> => {
      const matchingOwners = Object.entries(params.previousRecords ?? {}).filter(
        ([installOwner, record]) =>
          installOwner === artifact.pluginId ||
          installOwner === params.previousPluginOwners?.get(artifact.pluginId) ||
          Boolean(
            artifact.currentArtifactDir &&
            record.installPath &&
            path.resolve(resolveUserPath(artifact.currentArtifactDir, params.env)) ===
              path.resolve(resolveUserPath(record.installPath, params.env)),
          ),
      );
      if (matchingOwners.length > 1) {
        throw new ManagedPluginLifecycleError(
          `Plugin "${artifact.pluginId}" matches multiple installed package owners.`,
        );
      }
      const [installOwner, previousRecord] = matchingOwners[0] ?? [];
      const previousDeclared = installOwner ? previousDeclaredByOwner.get(installOwner) : undefined;
      const declared = await resolvePluginArtifactCapabilityConsent({
        config: params.config,
        env: params.env,
        pluginId: artifact.pluginId,
        artifactDir: artifact.stagedArtifactDir,
        currentArtifactDir: previousRecord?.installPath ?? artifact.currentArtifactDir,
        record: {
          source: params.source,
          installPath: artifact.stagedArtifactDir,
          ...(params.spec ? { spec: params.spec } : {}),
          ...(params.expectedIntegrity ? { integrity: params.expectedIntegrity } : {}),
        },
        acknowledgeCapabilities: params.acknowledgeCapabilities,
        onCapabilityConsent: params.onCapabilityConsent,
        beforePersistentEffect: params.beforePersistentEffect,
        ...(previousRecord ? { previousRecord } : {}),
        ...(previousDeclared ? { previousDeclared } : {}),
        mode: artifact.mode,
      });
      pendingAcceptedSurfaces.set(artifact.pluginId, declared);
    },
    applyAcceptedSurface: (pluginId, record) => {
      const declared = pendingAcceptedSurfaces.get(pluginId);
      if (!declared) {
        throw new ManagedPluginLifecycleError(
          `Plugin "${pluginId}" did not expose its verified artifact for capability review.`,
        );
      }
      return acceptManagedPluginDeclaredSurface(record, declared);
    },
  };
}

/** Prepare the same package-owned consent history for every managed installer. */
export async function prepareManagedPluginArtifactConsentHandler(
  params: Omit<
    Parameters<typeof createManagedPluginArtifactConsentHandler>[0],
    "previousPluginOwners"
  >,
) {
  const env = params.env ?? process.env;
  const previousRecords =
    params.previousRecords ?? (await loadInstalledPluginIndexInstallRecords({ env }));
  const workspace = resolvePluginControlPlaneWorkspace({ config: params.config, env });
  const metadata =
    Object.keys(previousRecords).length > 0
      ? resolvePluginMetadataSnapshot({
          allowCurrent: false,
          config: params.config,
          env,
          ...(workspace.workspaceDir !== undefined ? { workspaceDir: workspace.workspaceDir } : {}),
        })
      : undefined;
  const previousPluginOwners = new Map<string, string>();
  for (const plugin of metadata?.index.plugins ?? []) {
    const owner = resolveInstalledPluginIndexInstallOwner(plugin);
    if (owner) {
      previousPluginOwners.set(plugin.pluginId, owner);
    }
  }
  return createManagedPluginArtifactConsentHandler({
    ...params,
    env,
    previousRecords,
    previousPluginOwners,
  });
}

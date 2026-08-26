import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  PluginInspectSource,
  PluginInstallTrust,
  PluginsInspectResult,
} from "../../packages/gateway-protocol/src/schema/plugins.js";
import { MANIFEST_KEY } from "../compat/legacy-names.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginAcceptedDeclaredSurface,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import { isRootFileMissingFailure } from "../infra/boundary-file-read.js";
import { resolveRootPathSync } from "../infra/boundary-path.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { resolveUserPath } from "../utils.js";
import { detectBundleManifestFormat, loadBundleManifest } from "./bundle-manifest.js";
import { buildPluginCapabilitySummary } from "./capability-summary.js";
import { resolvePluginControlPlaneWorkspace } from "./control-plane-workspace.js";
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
import { loadPluginManifest, PLUGIN_MANIFEST_FILENAME } from "./manifest.js";
import { resolvePackageExtensionEntries } from "./package-manifest.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";

const DECLARED_SURFACE_GROUPS = [
  "channels",
  "providers",
  "tools",
  "contracts",
  "hooks",
  "mcpServers",
  "cliCommands",
  "cliBackends",
  "skills",
  "dangerousConfigFlags",
] as const satisfies readonly (keyof PluginAcceptedDeclaredSurface)[];

export function mergePluginDeclaredSurfaces(
  surfaces: Iterable<PluginAcceptedDeclaredSurface>,
): PluginAcceptedDeclaredSurface {
  const merged: PluginAcceptedDeclaredSurface = {
    channels: [],
    providers: [],
    tools: [],
    contracts: [],
    hooks: [],
    mcpServers: [],
    cliCommands: [],
    cliBackends: [],
    skills: [],
    dangerousConfigFlags: [],
  };
  for (const surface of surfaces) {
    for (const group of DECLARED_SURFACE_GROUPS) {
      merged[group].push(...surface[group]);
    }
  }
  for (const group of DECLARED_SURFACE_GROUPS) {
    merged[group] = [...new Set(merged[group])].toSorted();
  }
  return merged;
}

function resolvePluginArtifactManifests(rootDir: string, env: NodeJS.ProcessEnv = process.env) {
  const artifactRoot = fs.realpathSync(resolveUserPath(rootDir, env));
  const manifestRoots = new Set<string>();
  const addManifestRoot = (candidateRoot: string): void => {
    if (
      fs.existsSync(path.join(candidateRoot, PLUGIN_MANIFEST_FILENAME)) ||
      detectBundleManifestFormat(candidateRoot)
    ) {
      manifestRoots.add(candidateRoot);
    }
  };
  addManifestRoot(artifactRoot);

  const packageManifest = readRootJsonObjectSync({
    rootDir: artifactRoot,
    rootRealPath: artifactRoot,
    relativePath: "package.json",
    boundaryLabel: "plugin artifact directory",
    rejectHardlinks: true,
  });
  let hasPackageExtensions = false;
  if (!packageManifest.ok) {
    if (packageManifest.reason !== "open" || !isRootFileMissingFailure(packageManifest.failure)) {
      throw new Error(`Unable to inspect the plugin artifact package manifest: ${artifactRoot}`);
    }
  } else {
    const packageMetadata = packageManifest.value[MANIFEST_KEY];
    if (packageMetadata != null && !isRecord(packageMetadata)) {
      throw new Error("package.json openclaw must be an object");
    }
    const rawExtensions = packageMetadata?.extensions;
    if (
      rawExtensions !== undefined &&
      (!Array.isArray(rawExtensions) ||
        !rawExtensions.every((entry): entry is string => typeof entry === "string"))
    ) {
      throw new Error("package.json openclaw.extensions must be an array of strings");
    }
    const extensions = resolvePackageExtensionEntries({
      ...(packageMetadata
        ? {
            [MANIFEST_KEY]: {
              ...(rawExtensions ? { extensions: rawExtensions } : {}),
            },
          }
        : {}),
    });
    if (extensions.status === "invalid") {
      throw new Error(extensions.error);
    }
    hasPackageExtensions = extensions.entries.length > 0;
    for (const entry of extensions.entries) {
      const resolved = resolveRootPathSync({
        absolutePath: path.resolve(artifactRoot, entry),
        rootPath: artifactRoot,
        rootCanonicalPath: artifactRoot,
        boundaryLabel: "plugin artifact directory",
      });
      let candidateRoot =
        resolved.kind === "directory"
          ? resolved.canonicalPath
          : path.dirname(resolved.canonicalPath);
      while (candidateRoot !== artifactRoot) {
        addManifestRoot(candidateRoot);
        candidateRoot = path.dirname(candidateRoot);
      }
    }
  }

  if (manifestRoots.size === 0) {
    throw new Error(`Plugin artifact has no valid plugin manifest: ${artifactRoot}`);
  }
  return Array.from(manifestRoots, (manifestRoot) => {
    const hasNativeManifest = fs.existsSync(path.join(manifestRoot, PLUGIN_MANIFEST_FILENAME));
    const bundleFormat = detectBundleManifestFormat(manifestRoot);
    // Runtime discovery prioritizes package extensions over bundles, then bundles over native fallback.
    const loaded =
      hasPackageExtensions && hasNativeManifest
        ? loadPluginManifest(manifestRoot)
        : bundleFormat
          ? loadBundleManifest({ rootDir: manifestRoot, bundleFormat })
          : loadPluginManifest(manifestRoot);
    if (!loaded.ok) {
      throw new Error(loaded.error);
    }
    return loaded.manifest;
  });
}

/** Read only validated manifest surfaces belonging to the actual artifact on disk. */
export function resolvePluginArtifactDeclaredSurface(
  rootDir: string,
  env: NodeJS.ProcessEnv = process.env,
): PluginAcceptedDeclaredSurface {
  return mergePluginDeclaredSurfaces(
    resolvePluginArtifactManifests(rootDir, env).map(
      (manifest) => buildPluginCapabilitySummary({ manifest, origin: "global" }).declared,
    ),
  );
}

export function computeDeclaredSurfaceHash(declared: PluginAcceptedDeclaredSurface): string {
  const canonical = Object.fromEntries(
    DECLARED_SURFACE_GROUPS.map((group) => [group, declared[group].toSorted()]),
  );
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function diffDeclaredSurfaceWidening(
  previous: PluginAcceptedDeclaredSurface,
  next: PluginAcceptedDeclaredSurface,
): { widened: Partial<PluginAcceptedDeclaredSurface>; hasWidening: boolean } {
  const widened: Partial<PluginAcceptedDeclaredSurface> = {};
  for (const group of DECLARED_SURFACE_GROUPS) {
    const previousValues = new Set(previous[group]);
    const added = next[group].filter((value) => !previousValues.has(value)).toSorted();
    if (added.length > 0) {
      widened[group] = added;
    }
  }
  return { widened, hasWidening: Object.keys(widened).length > 0 };
}

export function resolvePluginInstallRecordIntegrity(
  record: Pick<PluginInstallRecord, "integrity" | "npmIntegrity" | "clawpackSha256" | "gitCommit">,
):
  | { integrity: string; integrityKind: NonNullable<PluginInspectSource["integrityKind"]> }
  | undefined {
  const npmIntegrity = record.integrity ?? record.npmIntegrity;
  if (npmIntegrity) {
    return { integrity: npmIntegrity, integrityKind: "ssri" };
  }
  if (record.clawpackSha256) {
    return { integrity: record.clawpackSha256, integrityKind: "sha256" };
  }
  return record.gitCommit
    ? { integrity: record.gitCommit, integrityKind: "git-commit" }
    : undefined;
}

export function resolveAcceptedSurfaceCurrent(
  record: PluginInstallRecord,
  declared: PluginAcceptedDeclaredSurface,
): boolean {
  return (
    record.acceptedSurface !== undefined &&
    record.acceptedSurfaceHash !== undefined &&
    record.acceptedSurfaceHash === computeDeclaredSurfaceHash(record.acceptedSurface) &&
    record.acceptedSurfaceHash === computeDeclaredSurfaceHash(declared) &&
    record.acceptedSurfaceIntegrity === resolvePluginInstallRecordIntegrity(record)?.integrity
  );
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

function acceptManagedPluginDeclaredSurface(
  record: PluginInstallRecord,
  declared: PluginAcceptedDeclaredSurface,
): PluginInstallRecord {
  const { acceptedSurfaceIntegrity: _previousIntegrity, ...unanchoredRecord } = record;
  const integrity = resolvePluginInstallRecordIntegrity(record)?.integrity;
  return {
    ...unanchoredRecord,
    acceptedSurface: declared,
    acceptedSurfaceHash: computeDeclaredSurfaceHash(declared),
    acceptedSurfaceAt: new Date().toISOString(),
    ...(integrity ? { acceptedSurfaceIntegrity: integrity } : {}),
  };
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
      ...(spec ? { spec } : {}),
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
    `Plugin "${review.pluginId}" requires capability consent; rerun with --accept-capabilities.`,
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
  metadata?: PluginMetadataSnapshot;
}): Promise<void> {
  const env = params.env ?? process.env;
  return await withPluginLifecycleLease({ env }, async (lease) => {
    const workspace = resolvePluginControlPlaneWorkspace({ config: params.config, env });
    const metadata =
      params.metadata ??
      resolvePluginMetadataSnapshot({
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
    const declared = mergePluginDeclaredSurfaces(
      ownership.value.pluginIds.map((ownedPluginId) => {
        const ownedManifest = metadata.byPluginId.get(ownedPluginId);
        if (!ownedManifest) {
          throw new ManagedPluginLifecycleError(
            `Plugin package "${installOwner}" is missing the manifest for "${ownedPluginId}".`,
          );
        }
        return buildPluginCapabilitySummary({
          manifest: ownedManifest,
          origin: ownedManifest.origin,
          entryConfig: params.config.plugins?.entries?.[ownedPluginId],
        }).declared;
      }),
    );
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
    if (!params.acknowledge) {
      return throwManagedPluginCapabilityConsentRequired(review);
    }
    const records = await loadInstalledPluginIndexInstallRecords({ env });
    const persistedRecord = records[installOwner];
    if (!persistedRecord?.installPath) {
      throw new ManagedPluginLifecycleError(
        `Plugin "${pluginId}" no longer has a verifiable installed package record.`,
      );
    }
    const currentDeclared = resolvePluginArtifactDeclaredSurface(persistedRecord.installPath, env);
    const currentReview = buildPluginCapabilityConsentReview({
      pluginId,
      manifest,
      record: persistedRecord,
      config: params.config,
      declared: currentDeclared,
    });
    // Bind the submitted acknowledgment to bytes reread after loading authoritative install state.
    if (params.acknowledge.reviewToken !== currentReview.reviewToken) {
      return throwManagedPluginCapabilityConsentRequired(currentReview);
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
  env?: NodeJS.ProcessEnv;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  previousDeclared?: PluginAcceptedDeclaredSurface;
  previousRecord?: PluginInstallRecord;
  previouslyEnabled?: boolean;
  mode?: "install" | "update";
}): Promise<PluginInstallRecord> {
  const declared = resolvePluginArtifactDeclaredSurface(params.artifactDir, params.env);
  const manifest = resolvePluginArtifactManifests(params.artifactDir, params.env)[0];
  const review = buildPluginCapabilityConsentReview({
    pluginId: params.pluginId,
    manifest: manifest ?? { name: params.pluginId },
    record: params.record,
    config: params.config,
    declared,
    ...(params.previousDeclared ? { previousDeclared: params.previousDeclared } : {}),
  });
  if (params.mode === "update" && params.previousDeclared) {
    const { hasWidening } = diffDeclaredSurfaceWidening(params.previousDeclared, declared);
    const priorAcceptanceCurrent =
      params.previousRecord !== undefined &&
      resolveAcceptedSurfaceCurrent(params.previousRecord, params.previousDeclared) &&
      resolvePluginInstallRecordIntegrity(params.previousRecord) !== undefined;
    if (!hasWidening && priorAcceptanceCurrent) {
      return acceptManagedPluginDeclaredSurface(params.record, declared);
    }
    if (
      params.previouslyEnabled === false ||
      (params.previouslyEnabled === undefined &&
        params.config.plugins?.entries?.[params.pluginId]?.enabled === false)
    ) {
      return params.record;
    }
  }
  const acknowledgment =
    params.acknowledgeCapabilities ?? (await params.onCapabilityConsent?.(review));
  // Interactive consent yields; re-read the final stage so a replaced artifact cannot inherit it.
  const finalDeclared = resolvePluginArtifactDeclaredSurface(params.artifactDir, params.env);
  const finalToken = computeDeclaredSurfaceHash(finalDeclared);
  if (!acknowledgment || acknowledgment.reviewToken !== finalToken) {
    const finalReview =
      finalToken === review.reviewToken
        ? review
        : buildPluginCapabilityConsentReview({
            pluginId: params.pluginId,
            manifest: resolvePluginArtifactManifests(params.artifactDir, params.env)[0] ?? {
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
  return acceptManagedPluginDeclaredSurface(params.record, finalDeclared);
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
  previousRecords?: Record<string, PluginInstallRecord>;
  previousPluginOwners?: ReadonlyMap<string, string>;
  previouslyEnabledInstallOwners?: ReadonlySet<string>;
}): {
  onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler;
  applyAcceptedSurface: (pluginId: string, record: PluginInstallRecord) => PluginInstallRecord;
} {
  const previousDeclaredByOwner = new Map<
    string,
    { declared: PluginAcceptedDeclaredSurface } | { error: unknown }
  >();
  for (const [installOwner, record] of Object.entries(params.previousRecords ?? {})) {
    if (record.installPath) {
      try {
        previousDeclaredByOwner.set(installOwner, {
          declared: resolvePluginArtifactDeclaredSurface(record.installPath, params.env),
        });
      } catch (error) {
        previousDeclaredByOwner.set(installOwner, { error });
      }
    }
  }
  const pendingAcceptedSurfaces = new Map<string, PluginAcceptedDeclaredSurface>();
  const reviewedPluginIds = new Set<string>();
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
      const previousArtifact = installOwner ? previousDeclaredByOwner.get(installOwner) : undefined;
      if (previousArtifact && "error" in previousArtifact) {
        throw new ManagedPluginLifecycleError(
          `Plugin "${artifact.pluginId}" has no verifiable previous installed artifact.`,
          { cause: previousArtifact.error },
        );
      }
      const previousDeclared = previousArtifact?.declared;
      const record = await resolvePluginArtifactCapabilityConsent({
        config: params.config,
        env: params.env,
        pluginId: artifact.pluginId,
        artifactDir: artifact.stagedArtifactDir,
        record: {
          source: params.source,
          installPath: artifact.stagedArtifactDir,
          ...(params.spec ? { spec: params.spec } : {}),
          ...(params.expectedIntegrity ? { integrity: params.expectedIntegrity } : {}),
        },
        acknowledgeCapabilities: params.acknowledgeCapabilities,
        onCapabilityConsent: params.onCapabilityConsent,
        ...(previousRecord ? { previousRecord } : {}),
        ...(previousDeclared ? { previousDeclared } : {}),
        ...(params.previouslyEnabledInstallOwners
          ? {
              previouslyEnabled: params.previouslyEnabledInstallOwners.has(
                installOwner ?? artifact.pluginId,
              ),
            }
          : {}),
        mode: artifact.mode,
      });
      if (record.acceptedSurface) {
        pendingAcceptedSurfaces.set(artifact.pluginId, record.acceptedSurface);
      }
      reviewedPluginIds.add(artifact.pluginId);
    },
    applyAcceptedSurface: (pluginId, record) => {
      if (!reviewedPluginIds.has(pluginId)) {
        throw new ManagedPluginLifecycleError(
          `Plugin "${pluginId}" did not expose its verified artifact for capability review.`,
        );
      }
      const declared = pendingAcceptedSurfaces.get(pluginId);
      return declared ? acceptManagedPluginDeclaredSurface(record, declared) : record;
    },
  };
}

export function formatPluginCapabilityConsentRequired(pluginId: string): string {
  return `Plugin "${pluginId}" requires capability consent; disable and re-enable it or run \`openclaw plugins enable ${pluginId} --accept-capabilities\`.`;
}

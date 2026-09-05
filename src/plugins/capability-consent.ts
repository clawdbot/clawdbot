import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginAcceptedDeclaredSurface,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import {
  inspectPluginCapabilityArtifact,
  resolvePluginArtifactDeclaredSurface,
} from "./capability-artifact.js";
import {
  buildPluginCapabilityConsentReview,
  computeDeclaredSurfaceHash,
  diffDeclaredSurfaceWidening,
  resolveAcceptedSurfaceCurrent,
  resolvePluginInstallRecordIntegrity,
  resolvePluginPackageDeclaredSurface,
  type PluginCapabilityConsentReview,
} from "./capability-summary.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
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
import { resolveInstalledPluginPackageOwnership } from "./installed-plugin-package-ownership.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import { isTrustedOfficialPluginInstallRecord } from "./official-external-install-records.js";
import { withPluginLifecycleLease } from "./plugin-lifecycle-lease.js";
import { registerPluginMetadataProcessMemoLifecycleClear } from "./plugin-metadata-lifecycle.js";
import {
  resolvePluginMetadataSnapshot,
  type PluginMetadataSnapshot,
} from "./plugin-metadata-snapshot.js";

export type PluginCapabilityConsentAcknowledgment = { reviewToken: string };

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
    if (manifest.trustedOfficialInstall) {
      pendingPluginCapabilityReviews.delete(pluginId);
      return;
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
  sourceRecord?: PluginInstallRecord;
  artifactDir: string;
  currentArtifactDir?: string;
  env?: NodeJS.ProcessEnv;
  acknowledgeCapabilities?: PluginCapabilityConsentAcknowledgment;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  beforePersistentEffect?: () => void | Promise<void>;
  previousDeclared?: PluginAcceptedDeclaredSurface;
  previousRecord?: PluginInstallRecord;
  mode?: "install" | "update";
  enabled: boolean;
}): Promise<PluginAcceptedDeclaredSurface | undefined> {
  const artifactContext = { config: params.config, currentArtifactDir: params.currentArtifactDir };
  const { declared, manifest } = inspectPluginCapabilityArtifact(
    params.artifactDir,
    params.env,
    artifactContext,
  );
  const isOfficialArtifact = (artifactManifest: typeof manifest) =>
    params.sourceRecord !== undefined &&
    isTrustedOfficialPluginInstallRecord({
      pluginId: params.pluginId,
      packageName: artifactManifest?.packageName,
      record: params.sourceRecord,
    });
  const official = isOfficialArtifact(manifest);
  const review = buildPluginCapabilityConsentReview({
    pluginId: params.pluginId,
    manifest: manifest ?? { name: params.pluginId },
    record: params.sourceRecord ?? params.record,
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
    // Reinstalls preserve authored disablement; required consent still precedes commit.
    // Only update-only flows defer it in preparePluginUpdateCapabilityConsent.
  }
  const acknowledgment =
    official || !params.enabled || acceptanceCurrent
      ? { reviewToken: review.reviewToken }
      : (params.acknowledgeCapabilities ?? (await params.onCapabilityConsent?.(review)));
  // Review and staged-package rollback remain cancellable. Lock only when
  // accepting this artifact, then recheck its bytes after the callback yields.
  if (acknowledgment) {
    await params.beforePersistentEffect?.();
  }
  // Interactive consent yields; re-read the final stage so a replaced artifact cannot inherit it.
  const { declared: finalDeclared, manifest: finalManifest } = inspectPluginCapabilityArtifact(
    params.artifactDir,
    params.env,
    artifactContext,
  );
  const finalToken = computeDeclaredSurfaceHash(finalDeclared);
  if (
    !acknowledgment ||
    acknowledgment.reviewToken !== finalToken ||
    (official && !isOfficialArtifact(finalManifest))
  ) {
    const finalReview =
      finalToken === review.reviewToken
        ? review
        : buildPluginCapabilityConsentReview({
            pluginId: params.pluginId,
            manifest: finalManifest ?? {
              name: params.pluginId,
            },
            record: params.sourceRecord ?? params.record,
            config: params.config,
            declared: finalDeclared,
            ...(params.previousDeclared ? { previousDeclared: params.previousDeclared } : {}),
          });
    return throwManagedPluginCapabilityConsentRequired(finalReview);
  }
  pendingPluginCapabilityReviews.delete(params.pluginId);
  // First-party provenance authorizes the artifact; it is not operator acceptance.
  return !official && (params.enabled || acceptanceCurrent) ? finalDeclared : undefined;
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
  /** Update-only flows may defer consent while every known package entry is disabled. */
  updatingPluginIds?: readonly string[];
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
  const pendingAcceptedSurfaces = new Map<string, PluginAcceptedDeclaredSurface | undefined>();
  return {
    onBeforePluginArtifactCommit: async (
      artifact: PluginInstallArtifactConsentRequest,
    ): Promise<void> => {
      // A fallback stage cannot inherit an earlier artifact's acceptance or exemption.
      pendingAcceptedSurfaces.clear();
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
        sourceRecord: artifact.sourceRecord,
        acknowledgeCapabilities: params.acknowledgeCapabilities,
        onCapabilityConsent: params.onCapabilityConsent,
        beforePersistentEffect: params.beforePersistentEffect,
        ...(previousRecord ? { previousRecord } : {}),
        ...(previousDeclared ? { previousDeclared } : {}),
        mode: artifact.mode,
        enabled:
          !params.updatingPluginIds?.length ||
          params.updatingPluginIds.some(
            (id) =>
              resolveEffectiveEnableState({
                id,
                origin: "global",
                config: normalizePluginsConfig(params.config.plugins),
                rootConfig: params.config,
              }).enabled,
          ),
      });
      pendingAcceptedSurfaces.set(artifact.pluginId, declared);
    },
    applyAcceptedSurface: (pluginId, record) => {
      const declared = pendingAcceptedSurfaces.get(pluginId);
      if (!pendingAcceptedSurfaces.has(pluginId)) {
        throw new ManagedPluginLifecycleError(
          `Plugin "${pluginId}" did not expose its verified artifact for capability review.`,
        );
      }
      return declared ? acceptManagedPluginDeclaredSurface(record, declared) : record;
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

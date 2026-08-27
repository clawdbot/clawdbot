import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginAcceptedDeclaredSurface,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import { readInstalledPackageManifest } from "../infra/package-update-utils.js";
import {
  buildPluginCapabilityConsentReview,
  computeDeclaredSurfaceHash,
  diffDeclaredSurfaceWidening,
  resolveAcceptedSurfaceCurrent,
  resolvePluginArtifactDeclaredSurface,
  resolvePluginInstallRecordIntegrity,
  type PluginCapabilityConsentHandler,
} from "./capability-consent.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";
import { ManagedPluginLifecycleError } from "./management-lifecycle-error.js";
import { loadPluginManifest } from "./manifest.js";

export function preparePluginUpdateCapabilityConsent(params: {
  config: OpenClawConfig;
  pluginId: string;
  record: PluginInstallRecord;
  installPath: string;
  packagePluginIds?: readonly string[];
  expectedIntegrity?: string;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
}): {
  onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler;
  acceptInstallRecord: <T extends PluginInstallRecord>(record: T) => T;
} {
  let previousDeclared: PluginAcceptedDeclaredSurface | undefined;
  try {
    // Capture the installed artifact before npm can mutate its managed root;
    // comparing against stored self-declarations lets malicious updates hide widening.
    previousDeclared = resolvePluginArtifactDeclaredSurface(params.installPath, process.env, {
      config: params.config,
    });
  } catch {
    // An unverifiable old payload cannot authorize its replacement; review the full stage.
  }

  let acceptedSurface: PluginAcceptedDeclaredSurface | undefined;
  let artifactReviewed = false;
  return {
    onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
      // Fallback attempts must not inherit an earlier stage's review or acceptance.
      acceptedSurface = undefined;
      artifactReviewed = false;
      const artifactContext = {
        config: params.config,
        // npm can stage a new generation; configured paths still refer to the recorded install.
        currentArtifactDir: params.installPath,
      };
      const declared = resolvePluginArtifactDeclaredSurface(
        stagedArtifactDir,
        process.env,
        artifactContext,
      );
      artifactReviewed = true;
      const { widened, hasWidening } = previousDeclared
        ? diffDeclaredSurfaceWidening(previousDeclared, declared)
        : { widened: undefined, hasWidening: false };
      const priorAcceptanceCurrent =
        previousDeclared !== undefined &&
        resolveAcceptedSurfaceCurrent(params.record, previousDeclared);
      const priorIntegrity = resolvePluginInstallRecordIntegrity(params.record);
      // Unknown package ownership must not let a disabled owner hide an enabled sibling.
      const enabled =
        !params.packagePluginIds?.length ||
        params.packagePluginIds.some(
          (ownedPluginId) =>
            resolveEffectiveEnableState({
              id: ownedPluginId,
              origin: "global",
              config: normalizePluginsConfig(params.config.plugins),
              rootConfig: params.config,
            }).enabled,
        );

      const requiresAcceptance =
        !previousDeclared ||
        hasWidening ||
        (params.record.acceptedSurface !== undefined &&
          (!priorAcceptanceCurrent || !priorIntegrity));
      if (requiresAcceptance && enabled) {
        const loadedManifest = loadPluginManifest(stagedArtifactDir);
        const packageManifest = readInstalledPackageManifest(stagedArtifactDir);
        const packageName =
          typeof packageManifest?.name === "string" ? packageManifest.name : undefined;
        const packageVersion =
          typeof packageManifest?.version === "string" ? packageManifest.version : undefined;
        const manifest = {
          ...(loadedManifest.ok ? loadedManifest.manifest : {}),
          name:
            (loadedManifest.ok ? loadedManifest.manifest.name : undefined) ??
            packageName ??
            params.pluginId,
          version:
            (loadedManifest.ok ? loadedManifest.manifest.version : undefined) ?? packageVersion,
        };
        const {
          integrity: _previousIntegrity,
          npmIntegrity: _previousNpmIntegrity,
          clawpackSha256: _previousClawpackIntegrity,
          gitCommit: _previousGitCommit,
          acceptedSurface: _previousAcceptedSurface,
          acceptedSurfaceHash: _previousAcceptedSurfaceHash,
          acceptedSurfaceAt: _previousAcceptedSurfaceAt,
          acceptedSurfaceIntegrity: _previousAcceptedSurfaceIntegrity,
          ...previousRecordWithoutIntegrity
        } = params.record;
        const review = buildPluginCapabilityConsentReview({
          config: params.config,
          pluginId: params.pluginId,
          record: {
            ...previousRecordWithoutIntegrity,
            ...(params.expectedIntegrity ? { integrity: params.expectedIntegrity } : {}),
          },
          manifest,
          declared,
          widened,
        });
        const acknowledgment = await params.onCapabilityConsent?.(review);
        // The prompt can yield while staged files change; bind approval to the final artifact.
        const finalDeclared = resolvePluginArtifactDeclaredSurface(
          stagedArtifactDir,
          process.env,
          artifactContext,
        );
        if (acknowledgment?.reviewToken !== computeDeclaredSurfaceHash(finalDeclared)) {
          throw new ManagedPluginLifecycleError(
            `Plugin "${params.pluginId}" requires capability consent; rerun with --accept-capabilities.`,
            {
              capabilityConsent: {
                pluginId: params.pluginId,
                reviewToken: computeDeclaredSurfaceHash(finalDeclared),
                ...(previousDeclared
                  ? {
                      widened: diffDeclaredSurfaceWidening(previousDeclared, finalDeclared).widened,
                    }
                  : {}),
              },
            },
          );
        }
        acceptedSurface = finalDeclared;
        return;
      }
      if (!hasWidening && priorAcceptanceCurrent && priorIntegrity) {
        acceptedSurface = declared;
      }
    },
    acceptInstallRecord: (record) => {
      if (!artifactReviewed) {
        throw new Error(
          `Plugin "${params.pluginId}" update did not review the staged artifact capabilities.`,
        );
      }
      if (!acceptedSurface) {
        return record;
      }
      const integrity = resolvePluginInstallRecordIntegrity(record)?.integrity;
      return {
        ...record,
        acceptedSurface,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
        acceptedSurfaceAt: new Date().toISOString(),
        ...(integrity ? { acceptedSurfaceIntegrity: integrity } : {}),
      };
    },
  };
}

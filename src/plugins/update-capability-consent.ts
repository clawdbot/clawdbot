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
  let previousArtifactError: unknown;
  try {
    // Capture the installed artifact before npm can mutate its managed root;
    // comparing against stored self-declarations lets malicious updates hide widening.
    previousDeclared = resolvePluginArtifactDeclaredSurface(params.installPath);
  } catch (error) {
    previousArtifactError = error;
  }

  let acceptedSurface: PluginAcceptedDeclaredSurface | undefined;
  let acceptedSurfaceAt: string | undefined;
  let artifactReviewed = false;
  return {
    onBeforePluginArtifactCommit: async ({ stagedArtifactDir }) => {
      if (!previousDeclared) {
        throw new Error(
          `Cannot verify installed capabilities for "${params.pluginId}": ${String(previousArtifactError)}`,
        );
      }
      const declared = resolvePluginArtifactDeclaredSurface(stagedArtifactDir);
      artifactReviewed = true;
      const { widened, hasWidening } = diffDeclaredSurfaceWidening(previousDeclared, declared);
      const priorAcceptanceCurrent = resolveAcceptedSurfaceCurrent(params.record, previousDeclared);
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
        const finalDeclared = resolvePluginArtifactDeclaredSurface(stagedArtifactDir);
        if (acknowledgment?.reviewToken !== computeDeclaredSurfaceHash(finalDeclared)) {
          throw new Error(
            `Plugin "${params.pluginId}" requires capability consent; rerun with --accept-capabilities.`,
          );
        }
        acceptedSurface = finalDeclared;
        acceptedSurfaceAt = new Date().toISOString();
        return;
      }
      if (!hasWidening && priorAcceptanceCurrent && priorIntegrity) {
        acceptedSurface = declared;
        acceptedSurfaceAt = new Date().toISOString();
      }
    },
    acceptInstallRecord: (record) => {
      if (previousDeclared && !artifactReviewed) {
        throw new Error(
          `Plugin "${params.pluginId}" update did not review the staged artifact capabilities.`,
        );
      }
      if (!acceptedSurface || !acceptedSurfaceAt) {
        return record;
      }
      const integrity = resolvePluginInstallRecordIntegrity(record)?.integrity;
      return {
        ...record,
        acceptedSurface,
        acceptedSurfaceHash: computeDeclaredSurfaceHash(acceptedSurface),
        acceptedSurfaceAt,
        ...(integrity ? { acceptedSurfaceIntegrity: integrity } : {}),
      };
    },
  };
}

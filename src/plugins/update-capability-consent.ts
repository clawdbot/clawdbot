import type { CapabilityConsentErrorDetails } from "../../packages/gateway-protocol/src/capability-consent-error-details.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  PluginAcceptedDeclaredSurface,
  PluginInstallRecord,
} from "../config/types.plugins.js";
import { readInstalledPackageManifest } from "../infra/package-update-utils.js";
import {
  computeDeclaredSurfaceHash,
  diffDeclaredSurfaceWidening,
  resolvePluginArtifactDeclaredSurface,
  resolvePluginInstallRecordIntegrity,
} from "./capability-consent.js";
import { buildPluginCapabilitySummary } from "./capability-summary.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";
import { loadPluginManifest } from "./manifest.js";

type PluginUpdateCapabilityConsentDetails = Omit<
  CapabilityConsentErrorDetails,
  "capabilityConsentCode"
>;

export type PluginUpdateCapabilityConsentHandler = (
  details: PluginUpdateCapabilityConsentDetails,
) => boolean | Promise<boolean>;

function buildPluginUpdateCapabilityConsentDetails(params: {
  config: OpenClawConfig;
  pluginId: string;
  record: PluginInstallRecord;
  stagedArtifactDir: string;
  declared: PluginAcceptedDeclaredSurface;
  widened: Partial<PluginAcceptedDeclaredSurface>;
}): PluginUpdateCapabilityConsentDetails {
  const manifest = loadPluginManifest(params.stagedArtifactDir);
  const packageManifest = readInstalledPackageManifest(params.stagedArtifactDir);
  const name =
    (manifest.ok ? manifest.manifest.name : undefined) ??
    (typeof packageManifest?.name === "string" ? packageManifest.name : undefined) ??
    params.pluginId;
  const version =
    (manifest.ok ? manifest.manifest.version : undefined) ??
    (typeof packageManifest?.version === "string" ? packageManifest.version : undefined);
  const spec = params.record.resolvedSpec ?? params.record.spec;
  const packageName = params.record.clawhubPackage ?? params.record.resolvedName;
  const integrity = resolvePluginInstallRecordIntegrity(params.record);
  const summary = buildPluginCapabilitySummary({
    manifest: manifest.ok ? manifest.manifest : {},
    origin: "global",
    entryConfig: params.config.plugins?.entries?.[params.pluginId],
  });
  return {
    pluginId: params.pluginId,
    name,
    ...(version ? { version } : {}),
    declared: params.declared,
    grants: summary.grants,
    source: {
      kind: params.record.source,
      ...(spec ? { spec } : {}),
      ...(packageName ? { packageName } : {}),
      ...(integrity
        ? {
            integrity,
            integrityKind:
              params.record.integrity || params.record.npmIntegrity
                ? ("ssri" as const)
                : params.record.clawpackSha256
                  ? ("sha256" as const)
                  : ("git-commit" as const),
          }
        : {}),
    },
    widened: params.widened,
    ...(params.record.clawhubTrustDisposition
      ? {
          trust: {
            disposition: params.record.clawhubTrustDisposition,
            ...(params.record.clawhubTrustReasons
              ? { reasons: params.record.clawhubTrustReasons }
              : {}),
            ...(params.record.clawhubTrustCheckedAt
              ? { checkedAt: params.record.clawhubTrustCheckedAt }
              : {}),
            ...(params.record.clawhubTrustAcknowledgedAt
              ? { acknowledgedAt: params.record.clawhubTrustAcknowledgedAt }
              : {}),
            ...(params.record.clawhubTrustPending !== undefined
              ? { pending: params.record.clawhubTrustPending }
              : {}),
            ...(params.record.clawhubTrustStale !== undefined
              ? { stale: params.record.clawhubTrustStale }
              : {}),
          },
        }
      : {}),
    ...(params.record.acceptedSurfaceAt ? { acceptedAt: params.record.acceptedSurfaceAt } : {}),
  };
}

export function preparePluginUpdateCapabilityConsent(params: {
  config: OpenClawConfig;
  pluginId: string;
  record: PluginInstallRecord;
  installPath: string;
  packagePluginIds?: readonly string[];
  acknowledgeCapabilities?: boolean;
  onCapabilityConsent?: PluginUpdateCapabilityConsentHandler;
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

      if (hasWidening && enabled) {
        const details = buildPluginUpdateCapabilityConsentDetails({
          ...params,
          stagedArtifactDir,
          declared,
          widened,
        });
        const accepted =
          params.acknowledgeCapabilities === true ||
          (params.onCapabilityConsent ? await params.onCapabilityConsent(details) : false);
        if (!accepted) {
          throw new Error(
            `Plugin "${params.pluginId}" declares new capabilities; rerun with --accept-capabilities.`,
          );
        }
        acceptedSurface = declared;
        acceptedSurfaceAt = new Date().toISOString();
        return;
      }
      if (!hasWidening && params.record.acceptedSurface) {
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
      const integrity = resolvePluginInstallRecordIntegrity(record);
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

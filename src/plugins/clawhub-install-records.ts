// Converts ClawHub plugin entries into install records.
import type { PluginInstallRecord } from "../config/types.plugins.js";
import type { ClawHubPackageChannel, ClawHubPackageFamily } from "../infra/clawhub.js";

/** Install record fields captured for ClawHub plugin installs. */
export type ClawHubPluginInstallRecordFields = {
  source: "clawhub";
  clawhubUrl: string;
  clawhubPackage: string;
  clawhubFamily: Exclude<ClawHubPackageFamily, "skill" | "claw">;
  clawhubChannel?: ClawHubPackageChannel;
  clawhubTrustDisposition?: "clean" | "review-recommended" | "review-required" | "blocked";
  clawhubTrustScanStatus?: string;
  clawhubTrustModerationState?: string;
  clawhubTrustReasons?: string[];
  clawhubTrustPending?: boolean;
  clawhubTrustStale?: boolean;
  clawhubTrustCheckedAt?: string;
  clawhubTrustAcknowledgedAt?: string;
  version?: string;
  integrity?: string;
  resolvedAt?: string;
  installedAt?: string;
  artifactKind?: "legacy-zip" | "npm-pack";
  artifactFormat?: "zip" | "tgz";
  npmIntegrity?: string;
  npmShasum?: string;
  npmTarballName?: string;
  clawpackSha256?: string;
  clawpackSpecVersion?: number;
  clawpackManifestSha256?: string;
  clawpackSize?: number;
};

/** Builds plugin install record fields from resolved ClawHub package metadata. */
export function buildClawHubPluginInstallRecordFields(
  fields: ClawHubPluginInstallRecordFields,
): Pick<
  PluginInstallRecord,
  | "source"
  | "clawhubUrl"
  | "clawhubPackage"
  | "clawhubFamily"
  | "clawhubChannel"
  | "clawhubTrustDisposition"
  | "clawhubTrustScanStatus"
  | "clawhubTrustModerationState"
  | "clawhubTrustReasons"
  | "clawhubTrustPending"
  | "clawhubTrustStale"
  | "clawhubTrustCheckedAt"
  | "clawhubTrustAcknowledgedAt"
  | "version"
  | "integrity"
  | "resolvedAt"
  | "installedAt"
  | "artifactKind"
  | "artifactFormat"
  | "npmIntegrity"
  | "npmShasum"
  | "npmTarballName"
  | "clawpackSha256"
  | "clawpackSpecVersion"
  | "clawpackManifestSha256"
  | "clawpackSize"
> {
  return {
    source: "clawhub",
    clawhubUrl: fields.clawhubUrl,
    clawhubPackage: fields.clawhubPackage,
    clawhubFamily: fields.clawhubFamily,
    ...(fields.clawhubChannel ? { clawhubChannel: fields.clawhubChannel } : {}),
    ...(fields.clawhubTrustDisposition
      ? { clawhubTrustDisposition: fields.clawhubTrustDisposition }
      : {}),
    ...(fields.clawhubTrustScanStatus
      ? { clawhubTrustScanStatus: fields.clawhubTrustScanStatus }
      : {}),
    ...(fields.clawhubTrustModerationState
      ? { clawhubTrustModerationState: fields.clawhubTrustModerationState }
      : {}),
    ...(fields.clawhubTrustReasons ? { clawhubTrustReasons: fields.clawhubTrustReasons } : {}),
    ...(fields.clawhubTrustPending !== undefined
      ? { clawhubTrustPending: fields.clawhubTrustPending }
      : {}),
    ...(fields.clawhubTrustStale !== undefined
      ? { clawhubTrustStale: fields.clawhubTrustStale }
      : {}),
    ...(fields.clawhubTrustCheckedAt
      ? { clawhubTrustCheckedAt: fields.clawhubTrustCheckedAt }
      : {}),
    ...(fields.clawhubTrustAcknowledgedAt
      ? { clawhubTrustAcknowledgedAt: fields.clawhubTrustAcknowledgedAt }
      : {}),
    ...(fields.version ? { version: fields.version } : {}),
    ...(fields.integrity ? { integrity: fields.integrity } : {}),
    ...(fields.resolvedAt ? { resolvedAt: fields.resolvedAt } : {}),
    ...(fields.installedAt ? { installedAt: fields.installedAt } : {}),
    ...(fields.artifactKind ? { artifactKind: fields.artifactKind } : {}),
    ...(fields.artifactFormat ? { artifactFormat: fields.artifactFormat } : {}),
    ...(fields.npmIntegrity ? { npmIntegrity: fields.npmIntegrity } : {}),
    ...(fields.npmShasum ? { npmShasum: fields.npmShasum } : {}),
    ...(fields.npmTarballName ? { npmTarballName: fields.npmTarballName } : {}),
    ...(fields.clawpackSha256 ? { clawpackSha256: fields.clawpackSha256 } : {}),
    ...(fields.clawpackSpecVersion !== undefined
      ? { clawpackSpecVersion: fields.clawpackSpecVersion }
      : {}),
    ...(fields.clawpackManifestSha256
      ? { clawpackManifestSha256: fields.clawpackManifestSha256 }
      : {}),
    ...(fields.clawpackSize !== undefined ? { clawpackSize: fields.clawpackSize } : {}),
  };
}

import type { NpmIntegrityDrift, NpmSpecResolution } from "../infra/install-source-utils.js";
import type { InstallPolicySource } from "../security/install-policy.js";
import type { PluginInstallArtifactInspection } from "./install-artifact-inspection.js";
import type { InstallSafetyOverrides } from "./install-security-scan.js";
import type { InstallPolicyWarningDetails } from "./install-security-scan.types.js";
import type { PackageManifest as PluginPackageManifest, PluginManifestSetup } from "./manifest.js";

export type PluginInstallLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

export type PackageManifest = PluginPackageManifest & {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
};

export const PLUGIN_INSTALL_ERROR_CODE = {
  INVALID_NPM_SPEC: "invalid_npm_spec",
  INVALID_MIN_HOST_VERSION: "invalid_min_host_version",
  UNKNOWN_HOST_VERSION: "unknown_host_version",
  INCOMPATIBLE_HOST_VERSION: "incompatible_host_version",
  INCOMPATIBLE_PLUGIN_API: "incompatible_plugin_api",
  INVALID_PLUGIN_API: "invalid_plugin_api",
  MISSING_OPENCLAW_EXTENSIONS: "missing_openclaw_extensions",
  MISSING_PLUGIN_MANIFEST: "missing_plugin_manifest",
  EMPTY_OPENCLAW_EXTENSIONS: "empty_openclaw_extensions",
  INVALID_OPENCLAW_EXTENSIONS: "invalid_openclaw_extensions",
  NPM_METADATA_FAILURE: "npm_metadata_failure",
  NPM_PACKAGE_NOT_FOUND: "npm_package_not_found",
  RELEASE_COHORT_UNAVAILABLE: "release_cohort_unavailable",
  PLUGIN_ID_MISMATCH: "plugin_id_mismatch",
  SECURITY_SCAN_BLOCKED: "security_scan_blocked",
  SECURITY_SCAN_FAILED: "security_scan_failed",
  UNSUPPORTED_PLAIN_FILE_PLUGIN: "unsupported_plain_file_plugin",
} as const;

export type PluginInstallErrorCode =
  (typeof PLUGIN_INSTALL_ERROR_CODE)[keyof typeof PLUGIN_INSTALL_ERROR_CODE];

export type InstallPluginResult =
  | {
      ok: true;
      pluginId: string;
      targetDir: string;
      manifestName?: string;
      version?: string;
      extensions: string[];
      setup?: PluginManifestSetup;
      artifactInspection?: PluginInstallArtifactInspection;
      npmResolution?: NpmSpecResolution;
      integrityDrift?: NpmIntegrityDrift;
    }
  | {
      ok: false;
      error: string;
      code?: PluginInstallErrorCode;
      installPolicyWarning?: InstallPolicyWarningDetails;
    };

export type PluginInstallFailureResult = Extract<InstallPluginResult, { ok: false }>;

export type PluginNpmIntegrityDriftParams = {
  spec: string;
  expectedIntegrity: string;
  actualIntegrity: string;
  resolution: NpmSpecResolution;
};

export type PluginInstallPolicyRequest = {
  kind: "plugin-dir" | "plugin-archive" | "plugin-npm" | "plugin-git";
  requestedSpecifier?: string;
  source?: InstallPolicySource;
};

export type PluginInstallArtifactConsentRequest = {
  pluginId: string;
  currentArtifactDir?: string;
  stagedArtifactDir: string;
  mode: "install" | "update";
};

export type PluginInstallArtifactConsentHandler = (
  request: PluginInstallArtifactConsentRequest,
) => Promise<void>;

export type PackageInstallCommonParams = InstallSafetyOverrides & {
  extensionsDir?: string;
  npmDir?: string;
  timeoutMs?: number;
  logger?: PluginInstallLogger;
  mode?: "install" | "update";
  dryRun?: boolean;
  expectedPluginId?: string;
  requirePluginManifest?: boolean;
  allowSourceTypeScriptEntries?: boolean;
  installPolicyRequest?: PluginInstallPolicyRequest;
  onBeforePluginArtifactCommit?: PluginInstallArtifactConsentHandler;
};

export type InternalPackageInstallCommonParams = PackageInstallCommonParams & {
  onEffectiveMode?: (mode: "install" | "update") => void;
};

/**
 * Detects npm failures caused by a target that is not published, as opposed to a
 * broken install. Channel-aware installs use this to widen the selector instead
 * of failing when the requested release has no artifact.
 */
export function isUnavailableNpmTarget(result: {
  ok: false;
  code?: string;
  error: string;
}): boolean {
  return (
    result.code === PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND ||
    /\b(ETARGET|notarget)\b|No matching version found|dist-tag|tag .*not found/i.test(result.error)
  );
}

// Runs security checks over plugin install candidates before activation.
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  InstallPolicyOrigin,
  InstallPolicyRequestKind,
  InstallPolicySource,
} from "../security/install-policy.js";
export type { InstallSafetyOverrides } from "./install-security-scan.types.js";
import type { InstallSafetyOverrides } from "./install-security-scan.types.js";

type InstallScanLogger = {
  warn?: (message: string) => void;
};

/** Result returned by plugin/skill install security policy checks. */
export type InstallSecurityScanResult = {
  blocked?: {
    code?: "security_scan_blocked" | "security_scan_failed";
    reason: string;
  };
};

/** Plugin install request kinds that share install policy without skill install semantics. */
type PluginInstallRequestKind = Exclude<InstallPolicyRequestKind, "skill-install">;

/** Skill install metadata shape passed into shared install policy evaluation. */
export type SkillInstallSpecMetadata = {
  id?: string;
  kind: "brew" | "node" | "go" | "uv" | "download";
  label?: string;
  bins?: string[];
  os?: string[];
  formula?: string;
  package?: string;
  module?: string;
  url?: string;
  archive?: string;
  extract?: boolean;
  stripComponents?: number;
  targetDir?: string;
};

/** Package executable metadata used to scope dependency and entrypoint scans. */
type PackageExecutableScanMetadata = {
  runtimeExtensions?: readonly string[];
  runtimeSetupEntry?: string;
  setupEntry?: string;
};

/** Lazily loads install scanning so normal plugin startup avoids policy/runtime imports. */
async function loadInstallSecurityScanRuntime() {
  return await import("./install-security-scan.runtime.js");
}

/** Scans an unpacked bundle source before plugin install/update. */
export async function scanBundleInstallSource(
  params: InstallSafetyOverrides & {
    config?: OpenClawConfig;
    logger: InstallScanLogger;
    pluginId: string;
    sourceDir: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    version?: string;
    source?: InstallPolicySource;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const { scanBundleInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanBundleInstallSourceRuntime(params);
}

/** Scans a package source directory and executable metadata before install/update. */
export async function scanPackageInstallSource(
  params: InstallSafetyOverrides & {
    config?: OpenClawConfig;
    extensions: string[];
    logger: InstallScanLogger;
    packageDir: string;
    packageMetadata?: PackageExecutableScanMetadata;
    pluginId: string;
    requestKind?: PluginInstallRequestKind;
    requestedSpecifier?: string;
    mode?: "install" | "update";
    packageName?: string;
    manifestId?: string;
    version?: string;
    source?: InstallPolicySource;
    trustedSourceLinkedOfficialInstall?: boolean;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const { scanPackageInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanPackageInstallSourceRuntime(params);
}

/** Scans the installed package dependency tree after npm resolution. */
export async function scanInstalledPackageDependencyTree(params: {
  additionalPackageDirs?: string[];
  allowManagedNpmRootPackagePeerSymlinks?: boolean;
  config?: OpenClawConfig;
  dangerouslyForceUnsafeInstall?: boolean;
  dependencyScanRootDir?: string;
  logger: InstallScanLogger;
  mode?: "install" | "update";
  packageDir: string;
  pluginId: string;
  requestKind?: PluginInstallRequestKind;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  trustedSourceLinkedOfficialInstall?: boolean;
}): Promise<InstallSecurityScanResult | undefined> {
  const { scanInstalledPackageDependencyTreeRuntime } = await loadInstallSecurityScanRuntime();
  return await scanInstalledPackageDependencyTreeRuntime(params);
}

/**
 * Retained for install.runtime compatibility with pre-v2026.6.5 lazy install chunks.
 * Remove only with the matching runtime-postbuild legacy alias cleanup.
 */
export async function scanFileInstallSource(
  params: InstallSafetyOverrides & {
    config?: OpenClawConfig;
    filePath: string;
    logger: InstallScanLogger;
    mode?: "install" | "update";
    pluginId: string;
    requestedSpecifier?: string;
    source?: InstallPolicySource;
  },
): Promise<InstallSecurityScanResult | undefined> {
  const { scanFileInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanFileInstallSourceRuntime(params);
}

/** Runs npm install policy checks before package install side effects. */
export async function preflightPluginNpmInstallPolicy(params: {
  config?: OpenClawConfig;
  logger: InstallScanLogger;
  mode?: "install" | "update";
  packageName: string;
  pluginId?: string;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  sourcePath: string;
  sourcePathKind: "file" | "directory";
}): Promise<InstallSecurityScanResult | undefined> {
  const { preflightPluginNpmInstallPolicyRuntime } = await loadInstallSecurityScanRuntime();
  return await preflightPluginNpmInstallPolicyRuntime(params);
}

/** Runs git install policy checks before plugin install side effects. */
export async function preflightPluginGitInstallPolicy(params: {
  config?: OpenClawConfig;
  logger: InstallScanLogger;
  mode?: "install" | "update";
  pluginId: string;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  sourcePath: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const { preflightPluginGitInstallPolicyRuntime } = await loadInstallSecurityScanRuntime();
  return await preflightPluginGitInstallPolicyRuntime(params);
}

/** Evaluates shared install policy for skill-managed dependency installs. */
export async function evaluateSkillInstallPolicy(params: {
  config?: OpenClawConfig;
  installId: string;
  installSpec?: SkillInstallSpecMetadata;
  logger: InstallScanLogger;
  origin: InstallPolicyOrigin;
  requestedSpecifier?: string;
  source?: InstallPolicySource;
  mode?: "install" | "update";
  skillName: string;
  sourceDir: string;
}): Promise<InstallSecurityScanResult | undefined> {
  const { evaluateSkillInstallPolicyRuntime } = await loadInstallSecurityScanRuntime();
  return await evaluateSkillInstallPolicyRuntime(params);
}

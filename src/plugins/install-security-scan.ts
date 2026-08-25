// Runs security checks over plugin install candidates before activation.
import type { InstallPolicyWarningDetails } from "./install-security-scan.types.js";
export type { InstallSafetyOverrides } from "./install-security-scan.types.js";

/** Result returned by plugin/skill install security policy checks. */
export type InstallSecurityScanResult = {
  blocked?: {
    code?: "security_scan_blocked" | "security_scan_failed";
    reason: string;
    installPolicyWarning?: InstallPolicyWarningDetails;
  };
};

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

/** Lazily loads install scanning so normal plugin startup avoids policy/runtime imports. */
async function loadInstallSecurityScanRuntime() {
  return await import("./install-security-scan.runtime.js");
}

/** Scans an unpacked bundle source before plugin install/update. */
export async function scanBundleInstallSource(
  params: Parameters<
    typeof import("./install-security-scan.runtime.js").scanBundleInstallSourceRuntime
  >[0],
): Promise<InstallSecurityScanResult | undefined> {
  const { scanBundleInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanBundleInstallSourceRuntime(params);
}

/** Scans a package source directory and executable metadata before install/update. */
export async function scanPackageInstallSource(
  params: Parameters<
    typeof import("./install-security-scan.runtime.js").scanPackageInstallSourceRuntime
  >[0],
): Promise<InstallSecurityScanResult | undefined> {
  const { scanPackageInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanPackageInstallSourceRuntime(params);
}

/** Scans the installed package dependency tree after npm resolution. */
export async function scanInstalledPackageDependencyTree(
  params: Parameters<
    typeof import("./install-security-scan.runtime.js").scanInstalledPackageDependencyTreeRuntime
  >[0],
): Promise<InstallSecurityScanResult | undefined> {
  const { scanInstalledPackageDependencyTreeRuntime } = await loadInstallSecurityScanRuntime();
  return await scanInstalledPackageDependencyTreeRuntime(params);
}

/**
 * Retained for install.runtime compatibility with pre-v2026.6.5 lazy install chunks.
 * Remove only with the matching runtime-postbuild legacy alias cleanup.
 */
export async function scanFileInstallSource(
  params: Parameters<
    typeof import("./install-security-scan.runtime.js").scanFileInstallSourceRuntime
  >[0],
): Promise<InstallSecurityScanResult | undefined> {
  const { scanFileInstallSourceRuntime } = await loadInstallSecurityScanRuntime();
  return await scanFileInstallSourceRuntime(params);
}

/** Runs npm install policy checks before package install side effects. */
export async function preflightPluginNpmInstallPolicy(
  params: Parameters<
    typeof import("./install-security-scan.runtime.js").preflightPluginNpmInstallPolicyRuntime
  >[0],
): Promise<InstallSecurityScanResult | undefined> {
  const { preflightPluginNpmInstallPolicyRuntime } = await loadInstallSecurityScanRuntime();
  return await preflightPluginNpmInstallPolicyRuntime(params);
}

/** Runs git install policy checks before plugin install side effects. */
export async function preflightPluginGitInstallPolicy(
  params: Parameters<
    typeof import("./install-security-scan.runtime.js").preflightPluginGitInstallPolicyRuntime
  >[0],
): Promise<InstallSecurityScanResult | undefined> {
  const { preflightPluginGitInstallPolicyRuntime } = await loadInstallSecurityScanRuntime();
  return await preflightPluginGitInstallPolicyRuntime(params);
}

/** Evaluates shared install policy for skill-managed dependency installs. */
export async function evaluateSkillInstallPolicy(
  params: Parameters<
    typeof import("./install-security-scan.runtime.js").evaluateSkillInstallPolicyRuntime
  >[0],
): Promise<InstallSecurityScanResult | undefined> {
  const { evaluateSkillInstallPolicyRuntime } = await loadInstallSecurityScanRuntime();
  return await evaluateSkillInstallPolicyRuntime(params);
}

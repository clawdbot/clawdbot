/** Tracks control-plane plugin metadata context during registry and status operations. */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hashJson } from "./installed-plugin-index-hash.js";
import { resolveInstalledPluginIndexPolicyHash } from "./installed-plugin-index-policy.js";
import type { InstalledPluginIndex } from "./installed-plugin-index.js";
import { resolveInstalledManifestRegistryIndexFingerprint } from "./manifest-registry-installed.js";
import { resolvePluginCacheInputs, type PluginSourceRoots } from "./roots.js";

/** Discovery inputs that affect plugin source resolution. */
type PluginDiscoveryContext = {
  roots: PluginSourceRoots;
  loadPaths: readonly string[];
};

/** Control-plane fingerprint inputs that affect installed plugin activation. */
type PluginControlPlaneContext = {
  discovery: PluginDiscoveryContext;
  policyFingerprint: string;
  inventoryFingerprint?: string;
  activationFingerprint?: string;
};

/** Parameters used to resolve plugin discovery roots and load paths. */
type ResolvePluginDiscoveryContextParams = {
  config?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  workspaceDir?: string;
  loadPaths?: readonly string[];
};

/** Parameters used to resolve the plugin control-plane fingerprint. */
export type ResolvePluginControlPlaneContextParams = ResolvePluginDiscoveryContextParams & {
  activationFingerprint?: string;
  index?: InstalledPluginIndex;
  inventoryFingerprint?: string;
  policyHash?: string;
};

function resolveConfiguredPluginLoadPaths(
  config: OpenClawConfig | undefined,
): readonly string[] | undefined {
  const paths = config?.plugins?.load?.paths;
  return Array.isArray(paths) ? paths : undefined;
}

/** Resolves plugin discovery roots and load paths for cache/fingerprint callers. */
export function resolvePluginDiscoveryContext(
  params: ResolvePluginDiscoveryContextParams = {},
): PluginDiscoveryContext {
  return resolvePluginCacheInputs({
    env: params.env ?? process.env,
    workspaceDir: params.workspaceDir,
    loadPaths: [...(params.loadPaths ?? resolveConfiguredPluginLoadPaths(params.config) ?? [])],
  });
}
/** Hashes an already resolved plugin discovery context. */
export function fingerprintPluginDiscoveryContext(context: PluginDiscoveryContext): string {
  return hashJson(context);
}

/** Resolves all inputs that determine plugin control-plane activation state. */
function resolvePluginControlPlaneContext(
  params: ResolvePluginControlPlaneContextParams = {},
): PluginControlPlaneContext {
  const inventoryFingerprint =
    params.inventoryFingerprint ??
    (params.index ? resolveInstalledManifestRegistryIndexFingerprint(params.index) : undefined);
  return {
    discovery: resolvePluginDiscoveryContext(params),
    policyFingerprint: params.policyHash ?? resolveInstalledPluginIndexPolicyHash(params.config),
    ...(inventoryFingerprint ? { inventoryFingerprint } : {}),
    ...(params.activationFingerprint
      ? { activationFingerprint: params.activationFingerprint }
      : {}),
  };
}

/** Resolves a stable fingerprint for plugin control-plane activation state. */
export function resolvePluginControlPlaneFingerprint(
  params: ResolvePluginControlPlaneContextParams = {},
): string {
  return fingerprintPluginControlPlaneContext(resolvePluginControlPlaneContext(params));
}

function fingerprintPluginControlPlaneContext(context: PluginControlPlaneContext): string {
  return hashJson(context);
}

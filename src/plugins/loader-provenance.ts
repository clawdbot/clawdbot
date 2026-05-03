import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveUserPath } from "../utils.js";
import type { PluginCandidate } from "./discovery.js";
import { loadInstalledPluginIndexInstallRecordsSync } from "./installed-plugin-index-records.js";
import type { PluginManifestRecord } from "./manifest-registry.js";
import { isPathInside, safeRealpathSync, safeStatSync } from "./path-safety.js";
import type { PluginRecord, PluginRegistry } from "./registry.js";
import type { PluginLogger } from "./types.js";

type PathMatcher = {
  exact: Set<string>;
  dirs: string[];
};

type InstallTrackingRule = {
  trackedWithoutPaths: boolean;
  matcher: PathMatcher;
};

export type PluginProvenanceIndex = {
  loadPathMatcher: PathMatcher;
  installRules: Map<string, InstallTrackingRule>;
};

type OpenAllowlistWarningCache = {
  hasOpenAllowlistWarning(cacheKey: string): boolean;
  recordOpenAllowlistWarning(cacheKey: string): void;
};

function createPathMatcher(): PathMatcher {
  return { exact: new Set<string>(), dirs: [] };
}

function addPathToMatcher(
  matcher: PathMatcher,
  rawPath: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    return;
  }
  const resolved = resolveUserPath(trimmed, env);
  if (!resolved) {
    return;
  }
  const canonical = safeRealpathSync(resolved) ?? resolved;
  if (matcher.exact.has(canonical) || matcher.dirs.includes(canonical)) {
    return;
  }
  const stat = safeStatSync(canonical);
  if (stat?.isDirectory()) {
    matcher.dirs.push(canonical);
    return;
  }
  matcher.exact.add(canonical);
}

function matchesPathMatcher(matcher: PathMatcher, sourcePath: string): boolean {
  if (matcher.exact.has(sourcePath)) {
    return true;
  }
  return matcher.dirs.some((dirPath) => isPathInside(dirPath, sourcePath));
}

export function buildProvenanceIndex(params: {
  normalizedLoadPaths: string[];
  env: NodeJS.ProcessEnv;
}): PluginProvenanceIndex {
  const loadPathMatcher = createPathMatcher();
  for (const loadPath of params.normalizedLoadPaths) {
    addPathToMatcher(loadPathMatcher, loadPath, params.env);
  }

  const installRules = new Map<string, InstallTrackingRule>();
  const installs = loadInstalledPluginIndexInstallRecordsSync({ env: params.env });
  for (const [pluginId, install] of Object.entries(installs)) {
    const rule: InstallTrackingRule = {
      trackedWithoutPaths: false,
      matcher: createPathMatcher(),
    };
    const trackedPaths = [install.installPath, install.sourcePath]
      .map((entry) => normalizeOptionalString(entry))
      .filter((entry): entry is string => Boolean(entry));
    if (trackedPaths.length === 0) {
      rule.trackedWithoutPaths = true;
    } else {
      for (const trackedPath of trackedPaths) {
        addPathToMatcher(rule.matcher, trackedPath, params.env);
      }
    }
    installRules.set(pluginId, rule);
  }

  return { loadPathMatcher, installRules };
}

function isTrackedByProvenance(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): boolean {
  const sourcePath = resolveUserPath(params.source, params.env);
  const canonicalSourcePath = safeRealpathSync(sourcePath) ?? sourcePath;
  const installRule = params.index.installRules.get(params.pluginId);
  if (installRule) {
    if (installRule.trackedWithoutPaths) {
      return true;
    }
    if (matchesPathMatcher(installRule.matcher, canonicalSourcePath)) {
      return true;
    }
  }
  return matchesPathMatcher(params.index.loadPathMatcher, canonicalSourcePath);
}

function matchesExplicitInstallRule(params: {
  pluginId: string;
  source: string;
  index: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): boolean {
  const sourcePath = resolveUserPath(params.source, params.env);
  const canonicalSourcePath = safeRealpathSync(sourcePath) ?? sourcePath;
  const installRule = params.index.installRules.get(params.pluginId);
  if (!installRule || installRule.trackedWithoutPaths) {
    return false;
  }
  return matchesPathMatcher(installRule.matcher, canonicalSourcePath);
}

function resolveCandidateDuplicateRank(params: {
  candidate: PluginCandidate;
  manifestByRoot: Map<string, PluginManifestRecord>;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const manifestRecord = params.manifestByRoot.get(params.candidate.rootDir);
  const pluginId = manifestRecord?.id;
  const isExplicitInstall =
    params.candidate.origin === "global" &&
    pluginId !== undefined &&
    matchesExplicitInstallRule({
      pluginId,
      source: params.candidate.source,
      index: params.provenance,
      env: params.env,
    });

  if (params.candidate.origin === "config") {
    return 0;
  }
  if (params.candidate.origin === "global" && isExplicitInstall) {
    return 1;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids stay reserved unless the operator configured an override.
    return 2;
  }
  if (params.candidate.origin === "workspace") {
    return 3;
  }
  return 4;
}

export function compareDuplicateCandidateOrder(params: {
  left: PluginCandidate;
  right: PluginCandidate;
  manifestByRoot: Map<string, PluginManifestRecord>;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const leftPluginId = params.manifestByRoot.get(params.left.rootDir)?.id;
  const rightPluginId = params.manifestByRoot.get(params.right.rootDir)?.id;
  if (!leftPluginId || leftPluginId !== rightPluginId) {
    return 0;
  }
  return (
    resolveCandidateDuplicateRank({
      candidate: params.left,
      manifestByRoot: params.manifestByRoot,
      provenance: params.provenance,
      env: params.env,
    }) -
    resolveCandidateDuplicateRank({
      candidate: params.right,
      manifestByRoot: params.manifestByRoot,
      provenance: params.provenance,
      env: params.env,
    })
  );
}

export function warnWhenAllowlistIsOpen(params: {
  emitWarning: boolean;
  logger: PluginLogger;
  pluginsEnabled: boolean;
  allow: string[];
  warningCacheKey: string;
  warningCache: OpenAllowlistWarningCache;
  discoverablePlugins: Array<{ id: string; source: string; origin: PluginRecord["origin"] }>;
}) {
  if (!params.emitWarning) {
    return;
  }
  if (!params.pluginsEnabled) {
    return;
  }
  if (params.allow.length > 0) {
    return;
  }
  const autoDiscoverable = params.discoverablePlugins.filter(
    (entry) => entry.origin === "workspace" || entry.origin === "global",
  );
  if (autoDiscoverable.length === 0) {
    return;
  }
  if (params.warningCache.hasOpenAllowlistWarning(params.warningCacheKey)) {
    return;
  }
  const preview = autoDiscoverable
    .slice(0, 6)
    .map((entry) => `${entry.id} (${entry.source})`)
    .join(", ");
  const extra = autoDiscoverable.length > 6 ? ` (+${autoDiscoverable.length - 6} more)` : "";
  params.warningCache.recordOpenAllowlistWarning(params.warningCacheKey);
  params.logger.warn(
    `[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: ${preview}${extra}. Set plugins.allow to explicit trusted ids.`,
  );
}

export function warnAboutUntrackedLoadedPlugins(params: {
  registry: PluginRegistry;
  provenance: PluginProvenanceIndex;
  allowlist: string[];
  emitWarning: boolean;
  logger: PluginLogger;
  env: NodeJS.ProcessEnv;
}) {
  const allowSet = new Set(params.allowlist);
  for (const plugin of params.registry.plugins) {
    if (plugin.status !== "loaded" || plugin.origin === "bundled") {
      continue;
    }
    if (allowSet.has(plugin.id)) {
      continue;
    }
    if (
      isTrackedByProvenance({
        pluginId: plugin.id,
        source: plugin.source,
        index: params.provenance,
        env: params.env,
      })
    ) {
      continue;
    }
    const message =
      "loaded without install/load-path provenance; treat as untracked local code and pin trust via plugins.allow or install records";
    params.registry.diagnostics.push({
      level: "warn",
      pluginId: plugin.id,
      source: plugin.source,
      message,
    });
    if (params.emitWarning) {
      params.logger.warn(`[plugins] ${plugin.id}: ${message} (${plugin.source})`);
    }
  }
}

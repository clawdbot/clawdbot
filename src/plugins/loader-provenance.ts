// Tracks plugin loader provenance for diagnostics and policy checks.
import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import { quoteCliArg } from "../cli/quote-cli-arg.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { isBundledPluginInsideDevSourceRoot } from "./dev-source-root.js";
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

/** Provenance lookup for trusted plugin load paths and install records. */
type PluginProvenanceIndex = {
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

function formatPluginInspectCommand(pluginId: string): string {
  return `openclaw plugins inspect ${quoteCliArg(pluginId)}`;
}

/** Builds provenance matchers from configured load paths and install records. */
export function buildProvenanceIndex(params: {
  normalizedLoadPaths: string[];
  env: NodeJS.ProcessEnv;
  installRecords?: Record<string, PluginInstallRecord>;
}): PluginProvenanceIndex {
  const loadPathMatcher = createPathMatcher();
  for (const loadPath of params.normalizedLoadPaths) {
    addPathToMatcher(loadPathMatcher, loadPath, params.env);
  }

  const installRules = new Map<string, InstallTrackingRule>();
  const installs =
    params.installRecords ?? loadInstalledPluginIndexInstallRecordsSync({ env: params.env });
  for (const [pluginId, install] of Object.entries(installs)) {
    const rule: InstallTrackingRule = {
      trackedWithoutPaths: false,
      matcher: createPathMatcher(),
    };
    const trackedPaths = normalizeTrimmedStringList([install.installPath, install.sourcePath]);
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
  manifestBySource: Map<string, PluginManifestRecord>;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const manifestRecord = params.manifestBySource.get(params.candidate.source);
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
  if (
    params.candidate.origin === "bundled" &&
    isBundledPluginInsideDevSourceRoot({
      rootDir: params.candidate.rootDir,
      env: params.env,
    })
  ) {
    return 1;
  }
  if (params.candidate.origin === "global" && isExplicitInstall) {
    return 2;
  }
  if (params.candidate.origin === "bundled") {
    // Bundled plugin ids stay reserved unless the operator configured an override.
    return 3;
  }
  if (params.candidate.origin === "workspace") {
    return 4;
  }
  return 5;
}

/** Orders duplicate plugin candidates by configured, installed, bundled, then workspace trust. */
export function compareDuplicateCandidateOrder(params: {
  left: PluginCandidate;
  right: PluginCandidate;
  manifestBySource: Map<string, PluginManifestRecord>;
  provenance: PluginProvenanceIndex;
  env: NodeJS.ProcessEnv;
}): number {
  const leftPluginId = params.manifestBySource.get(params.left.source)?.id;
  const rightPluginId = params.manifestBySource.get(params.right.source)?.id;
  if (!leftPluginId || leftPluginId !== rightPluginId) {
    return 0;
  }
  return (
    resolveCandidateDuplicateRank({
      candidate: params.left,
      manifestBySource: params.manifestBySource,
      provenance: params.provenance,
      env: params.env,
    }) -
    resolveCandidateDuplicateRank({
      candidate: params.right,
      manifestBySource: params.manifestBySource,
      provenance: params.provenance,
      env: params.env,
    })
  );
}

/** Warns when an open plugin allowlist may auto-load non-bundled plugins. */
export function warnWhenAllowlistIsOpen(params: {
  emitWarning: boolean;
  logger: PluginLogger;
  pluginsEnabled: boolean;
  allow: string[];
  warningCacheKey: string;
  warningCache: OpenAllowlistWarningCache;
  explicitlyEnabledPluginIds?: ReadonlySet<string>;
  discoverablePlugins: Array<{ id: string; source: string; origin: PluginRecord["origin"] }>;
}) {
  if (!params.emitWarning) {
    return;
  }
  if (!params.pluginsEnabled) {
    return;
  }
  const autoDiscoverable = params.discoverablePlugins.filter(
    (entry) =>
      (entry.origin === "workspace" || entry.origin === "global") &&
      !params.explicitlyEnabledPluginIds?.has(entry.id),
  );
  if (autoDiscoverable.length === 0) {
    return;
  }
  // Match allow entries against every discovered plugin id, including bundled ids. Otherwise a
  // valid bundled-only allowlist would look mismatched whenever workspace/global plugins exist.
  const allDiscoveredIds = new Set(params.discoverablePlugins.map((entry) => entry.id));
  const hasConfiguredAllowlist = params.allow.length > 0;
  const allowHasDiscoveredMatch = params.allow.some((id) => allDiscoveredIds.has(id));
  if (hasConfiguredAllowlist && allowHasDiscoveredMatch) {
    return;
  }
  if (params.warningCache.hasOpenAllowlistWarning(params.warningCacheKey)) {
    return;
  }
  const preview = autoDiscoverable
    .slice(0, 6)
    .map((entry) => `${entry.id} (${entry.source})`)
    .join(", ");
  const truncated = autoDiscoverable.length > 6;
  const extra = truncated ? ` (+${autoDiscoverable.length - 6} more)` : "";
  const inspectCommands = autoDiscoverable
    .map((entry) => `'${formatPluginInspectCommand(entry.id)}'`)
    .join(", ");
  // Skip the snippet when truncated: a previewed-only allowlist would silently disable the rest
  const remediation = truncated
    ? "Run 'openclaw plugins list --enabled --verbose' to enumerate every discovered plugin id, inspect trusted ids with 'openclaw plugins inspect <id>', and add the ones you trust to plugins.allow in openclaw.json."
    : `To trust them explicitly, set plugins.allow in openclaw.json (e.g. "plugins": { "allow": [${autoDiscoverable
        .map((entry) => JSON.stringify(entry.id))
        .join(
          ", ",
        )}] }). Run 'openclaw plugins list --enabled --verbose' or ${inspectCommands} to confirm plugin ids.`;
  params.warningCache.recordOpenAllowlistWarning(params.warningCacheKey);
  if (!hasConfiguredAllowlist) {
    params.logger.warn(
      `[plugins] plugins.allow is empty; discovered non-bundled plugins may auto-load: ${preview}${extra}. ${remediation}`,
    );
    return;
  }
  const unmatchedEntries = params.allow.filter((id) => !allDiscoveredIds.has(id));
  const unmatchedPreview = unmatchedEntries
    .slice(0, 6)
    .map((id) => `"${id}"`)
    .join(", ");
  const unmatchedExtra =
    unmatchedEntries.length > 6 ? ` (+${unmatchedEntries.length - 6} more)` : "";
  params.logger.warn(
    `[plugins] plugins.allow entries ${unmatchedPreview}${unmatchedExtra} do not match any discovered plugin ids; discovered non-bundled plugins: ${preview}${extra}. Use the plugin id (not a channel id or npm package name).`,
  );
}

/** Adds diagnostics for loaded plugins without install or load-path provenance. */
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
    const message = `OpenClaw can't verify where this plugin came from. Review it with '${formatPluginInspectCommand(plugin.id)}'. Adding it to plugins.allow lets it load, but does not make it trusted. If it's an official plugin, reinstall it from its official npm package or its official ClawHub listing to enable trusted features.`;
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

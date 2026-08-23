// Doctor warnings and repairs for redundant bundled plugin load path aliases.
import path from "node:path";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import { resolveAgentWorkspaceDir, tryResolveDefaultAgentId } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import {
  buildBundledPluginLoadPathAliases,
  normalizeBundledLookupPath,
  parseLegacyBundledPluginPath,
  parsePackagedBundledPluginPath,
} from "../../../plugins/bundled-load-path-aliases.js";
import { resolveBundledPluginSources } from "../../../plugins/bundled-sources.js";
import { resolveUserPath } from "../../../utils.js";
import { asObjectRecord } from "./object.js";

type BundledPluginLoadPathHit = {
  pluginId: string;
  fromPath: string;
  toPath: string;
  pathLabel: string;
};

function resolveBundledWorkspaceDir(cfg: OpenClawConfig): string | undefined {
  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  return defaultAgentId ? resolveAgentWorkspaceDir(cfg, defaultAgentId) : undefined;
}

function isOpenClawNodeModulesPackageRoot(packageRoot: string): boolean {
  const normalized = normalizeBundledLookupPath(packageRoot);
  const packageDir = path.basename(normalized);
  const parentDir = path.basename(path.dirname(normalized));
  return packageDir === "openclaw" && parentDir === "node_modules";
}

/** Find configured plugin load paths that alias bundled plugins already shipped by OpenClaw. */
export function scanBundledPluginLoadPathMigrations(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): BundledPluginLoadPathHit[] {
  const plugins = asObjectRecord(cfg.plugins);
  const load = asObjectRecord(plugins?.load);
  const rawPaths = Array.isArray(load?.paths) ? load.paths : [];
  if (rawPaths.length === 0) {
    return [];
  }

  const bundled = resolveBundledPluginSources({
    workspaceDir: resolveBundledWorkspaceDir(cfg),
    env,
  });
  if (bundled.size === 0) {
    return [];
  }

  const bundledPathMap = new Map<string, { pluginId: string; toPath: string }>();
  const packagedBundledLeafMap = new Map<string, { pluginId: string; toPath: string }>();
  for (const source of bundled.values()) {
    for (const alias of buildBundledPluginLoadPathAliases(source.localPath)) {
      bundledPathMap.set(normalizeBundledLookupPath(alias.path), {
        pluginId: source.pluginId,
        toPath: source.localPath,
      });
    }
    const packaged = parsePackagedBundledPluginPath(source.localPath);
    if (packaged) {
      packagedBundledLeafMap.set(normalizeBundledLookupPath(packaged.bundledLeaf), {
        pluginId: source.pluginId,
        toPath: source.localPath,
      });
    }
  }

  const hits: BundledPluginLoadPathHit[] = [];
  for (const rawPath of rawPaths) {
    if (typeof rawPath !== "string") {
      continue;
    }
    const normalized = normalizeBundledLookupPath(resolveUserPath(rawPath, env));
    const match = bundledPathMap.get(normalized);
    if (!match) {
      const oldPackaged = parsePackagedBundledPluginPath(normalized);
      const oldLegacy = oldPackaged ? null : parseLegacyBundledPluginPath(normalized);
      const oldPackageRoot = oldPackaged?.packageRoot ?? oldLegacy?.packageRoot;
      const oldBundledLeaf = oldPackaged?.bundledLeaf ?? oldLegacy?.bundledLeaf;
      const oldPackageMatch =
        // Only rewrite paths rooted in the installed OpenClaw package; user plugin paths stay intact.
        oldPackageRoot && oldBundledLeaf && isOpenClawNodeModulesPackageRoot(oldPackageRoot)
          ? packagedBundledLeafMap.get(normalizeBundledLookupPath(oldBundledLeaf))
          : undefined;
      if (!oldPackageMatch) {
        continue;
      }
      hits.push({
        pluginId: oldPackageMatch.pluginId,
        fromPath: rawPath,
        toPath: oldPackageMatch.toPath,
        pathLabel: "plugins.load.paths",
      });
      continue;
    }
    hits.push({
      pluginId: match.pluginId,
      fromPath: rawPath,
      toPath: match.toPath,
      pathLabel: "plugins.load.paths",
    });
  }

  return hits;
}

/** Format user-facing warnings for redundant bundled plugin load path aliases. */
export function collectBundledPluginLoadPathWarnings(params: {
  hits: BundledPluginLoadPathHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const lines = params.hits.map(
    (hit) =>
      `- ${hit.pathLabel}: bundled plugin path "${hit.fromPath}" still aliases ${hit.pluginId}; OpenClaw loads the packaged bundled plugin from "${hit.toPath}".`,
  );
  lines.push(`- Run "${params.doctorFixCommand}" to remove these redundant bundled plugin paths.`);
  return lines.map((line) => sanitizeForLog(line));
}

/** Remove redundant bundled plugin load path aliases while preserving unrelated custom paths. */
export function maybeRepairBundledPluginLoadPaths(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
): {
  config: OpenClawConfig;
  changes: string[];
} {
  const hits = scanBundledPluginLoadPathMigrations(cfg, env);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const paths = next.plugins?.load?.paths;
  if (!Array.isArray(paths)) {
    return { config: cfg, changes: [] };
  }

  const removable = new Set(
    hits.map((hit) => normalizeBundledLookupPath(resolveUserPath(hit.fromPath, env))),
  );
  const seen = new Set<string>();
  const rewritten: Array<(typeof paths)[number]> = [];
  for (const entry of paths) {
    if (typeof entry !== "string") {
      rewritten.push(entry);
      continue;
    }
    const resolved = normalizeBundledLookupPath(resolveUserPath(entry, env));
    if (removable.has(resolved)) {
      continue;
    }
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    rewritten.push(entry);
  }

  next.plugins = {
    ...next.plugins,
    load: {
      ...next.plugins?.load,
      paths: rewritten,
    },
  };

  return {
    config: next,
    changes: hits.map(
      (hit) => `- plugins.load.paths: removed bundled ${hit.pluginId} path alias ${hit.fromPath}`,
    ),
  };
}

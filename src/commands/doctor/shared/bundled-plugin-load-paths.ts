import path from "node:path";
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../../agents/agent-scope.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveBundledPluginSources } from "../../../plugins/bundled-sources.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { resolveUserPath } from "../../../utils.js";
import { asObjectRecord } from "./object.js";

type BundledPluginLoadPathHit = {
  pluginId: string;
  fromPath: string;
  toPath: string;
  pathLabel: string;
};

function resolveBundledWorkspaceDir(cfg: OpenClawConfig): string | undefined {
  return resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)) ?? undefined;
}

function normalizeBundledLookupPath(targetPath: string): string {
  const normalized = path.normalize(targetPath);
  const root = path.parse(normalized).root;
  let trimmed = normalized;
  while (trimmed.length > root.length && (trimmed.endsWith(path.sep) || trimmed.endsWith("/"))) {
    trimmed = trimmed.slice(0, -1);
  }
  return trimmed;
}

function buildLegacyBundledPath(localPath: string): string | null {
  const normalized = normalizeBundledLookupPath(localPath);
  for (const bundledRoot of [
    path.join("dist", "extensions"),
    path.join("dist-runtime", "extensions"),
  ]) {
    const marker = `${bundledRoot}${path.sep}`;
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex === -1) {
      continue;
    }
    const packageRoot = normalized.slice(0, markerIndex);
    const bundledLeaf = normalized.slice(markerIndex + marker.length);
    if (!bundledLeaf) {
      continue;
    }
    return path.join(packageRoot, "extensions", bundledLeaf);
  }
  return null;
}

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

  const legacyPathMap = new Map<string, { pluginId: string; toPath: string }>();
  for (const source of bundled.values()) {
    const legacyPath = buildLegacyBundledPath(source.localPath);
    if (!legacyPath) {
      continue;
    }
    legacyPathMap.set(normalizeBundledLookupPath(legacyPath), {
      pluginId: source.pluginId,
      toPath: source.localPath,
    });
  }

  const hits: BundledPluginLoadPathHit[] = [];
  for (const rawPath of rawPaths) {
    if (typeof rawPath !== "string") {
      continue;
    }
    const normalized = normalizeBundledLookupPath(resolveUserPath(rawPath, env));
    const match = legacyPathMap.get(normalized);
    if (!match) {
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

export function collectBundledPluginLoadPathWarnings(params: {
  hits: BundledPluginLoadPathHit[];
  doctorFixCommand: string;
}): string[] {
  if (params.hits.length === 0) {
    return [];
  }
  const lines = params.hits.map(
    (hit) =>
      `- ${hit.pathLabel}: legacy bundled plugin path "${hit.fromPath}" still points at ${hit.pluginId}; current packaged path is "${hit.toPath}".`,
  );
  lines.push(`- Run "${params.doctorFixCommand}" to rewrite these bundled plugin paths.`);
  return lines.map((line) => sanitizeForLog(line));
}

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

  const replacements = new Map(
    hits.map((hit) => [normalizeBundledLookupPath(resolveUserPath(hit.fromPath, env)), hit]),
  );
  const seen = new Set<string>();
  const rewritten: Array<(typeof paths)[number]> = [];
  for (const entry of paths) {
    if (typeof entry !== "string") {
      rewritten.push(entry);
      continue;
    }
    const resolved = normalizeBundledLookupPath(resolveUserPath(entry, env));
    const replacement = replacements.get(resolved)?.toPath ?? entry;
    const replacementResolved = normalizeBundledLookupPath(resolveUserPath(replacement, env));
    if (seen.has(replacementResolved)) {
      continue;
    }
    seen.add(replacementResolved);
    rewritten.push(replacement);
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
      (hit) =>
        `- plugins.load.paths: rewrote bundled ${hit.pluginId} path from ${hit.fromPath} to ${hit.toPath}`,
    ),
  };
}

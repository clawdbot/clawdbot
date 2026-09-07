// Plugin hook helpers discover hooks contributed by installed plugins.
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolvePluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { iteratePluginRootContributions } from "../plugins/plugin-root-contributions.js";

type PluginHookDirEntry = {
  dir: string;
  pluginId: string;
  rootDir: string;
};

/** Resolve hook directories declared by active plugin manifests. */
export function resolvePluginHookDirs(params: {
  workspaceDir: string | undefined;
  config?: OpenClawConfig;
}): PluginHookDirEntry[] {
  const workspaceDir = (params.workspaceDir ?? "").trim();
  if (!workspaceDir) {
    return [];
  }
  const metadataSnapshot = resolvePluginMetadataSnapshot({
    workspaceDir,
    config: params.config,
    env: process.env,
  });
  const registry = metadataSnapshot.manifestRegistry;
  if (registry.plugins.length === 0) {
    return [];
  }

  const seen = new Set<string>();
  const resolved: PluginHookDirEntry[] = [];

  for (const { record, roots } of iteratePluginRootContributions({
    metadataSnapshot,
    config: params.config,
    contribution: "hooks",
  })) {
    for (const raw of roots) {
      const trimmed = raw.trim();
      if (!trimmed) {
        continue;
      }
      const candidate = path.resolve(record.rootDir, trimmed);
      if (seen.has(candidate)) {
        continue;
      }
      seen.add(candidate);
      resolved.push({
        dir: candidate,
        pluginId: record.id,
        rootDir: record.rootDir,
      });
    }
  }

  return resolved;
}

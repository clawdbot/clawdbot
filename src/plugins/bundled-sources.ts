// Resolves bundled plugin source metadata from package manifests.
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { getGatewayPluginMetadataSnapshot } from "./current-plugin-metadata-state.js";
import { discoverOpenClawPlugins, type PluginDiscoveryResult } from "./discovery.js";
import { loadPluginManifest } from "./manifest.js";

export type BundledPluginSource = {
  pluginId: string;
  localPath: string;
  npmSpec?: string;
  version?: string;
  configSchema?: Record<string, unknown>;
  requiresConfig?: boolean;
};

type BundledPluginLookup =
  | { kind: "localPath"; value: string }
  | { kind: "npmSpec"; value: string }
  | { kind: "pluginId"; value: string };

export function findBundledPluginSourceInMap(params: {
  bundled: ReadonlyMap<string, BundledPluginSource>;
  lookup: BundledPluginLookup;
}): BundledPluginSource | undefined {
  const targetValue = params.lookup.value.trim();
  if (!targetValue) {
    return undefined;
  }
  if (params.lookup.kind === "pluginId") {
    return params.bundled.get(targetValue);
  }
  for (const source of params.bundled.values()) {
    if (
      (params.lookup.kind === "npmSpec" && source.npmSpec === targetValue) ||
      (params.lookup.kind === "localPath" &&
        path.resolve(source.localPath) === path.resolve(targetValue))
    ) {
      return source;
    }
  }
  return undefined;
}

export function resolveBundledPluginSources(params: {
  workspaceDir?: string;
  /** Use an explicit env when bundled roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
  discovery?: PluginDiscoveryResult;
}): Map<string, BundledPluginSource> {
  const snapshot = params.discovery ? undefined : getGatewayPluginMetadataSnapshot();
  const sources = snapshot
    ? (snapshot.bundledManifestRegistry?.plugins ?? []).map((manifest) => ({
        candidate: manifest,
        manifest,
      }))
    : (
        params.discovery ??
        discoverOpenClawPlugins({ workspaceDir: params.workspaceDir, env: params.env })
      ).candidates.flatMap((candidate) => {
        if (candidate.origin !== "bundled") {
          return [];
        }
        const loaded = loadPluginManifest(candidate.rootDir, false);
        return loaded.ok ? [{ candidate, manifest: loaded.manifest }] : [];
      });
  const bundled = new Map<string, BundledPluginSource>();

  for (const { candidate, manifest } of sources) {
    const pluginId = manifest.id;
    if (bundled.has(pluginId)) {
      continue;
    }

    const npmSpec =
      normalizeOptionalString(candidate.packageManifest?.install?.npmSpec) ||
      normalizeOptionalString(candidate.packageName) ||
      undefined;

    const version =
      normalizeOptionalString(candidate.packageVersion) ||
      normalizeOptionalString(manifest.version) ||
      undefined;

    bundled.set(pluginId, {
      pluginId,
      localPath: candidate.rootDir,
      npmSpec,
      version,
      ...(isRecord(manifest.configSchema) ? { configSchema: manifest.configSchema } : {}),
      requiresConfig: pluginConfigSchemaHasRequiredFields(manifest.configSchema),
    });
  }

  return bundled;
}

/** Projects bundled sources from the current generation's shared discovery facts. */
export function getProcessBundledPluginSources(): ReadonlyMap<string, BundledPluginSource> {
  return resolveBundledPluginSources({});
}

function pluginConfigSchemaHasRequiredFields(schema: unknown): boolean {
  if (!isRecord(schema)) {
    return false;
  }
  const required = schema.required;
  return Array.isArray(required) && required.some((entry) => typeof entry === "string");
}

export function findBundledPluginSource(params: {
  lookup: BundledPluginLookup;
  workspaceDir?: string;
  /** Use an explicit env when bundled roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
}): BundledPluginSource | undefined {
  const bundled = resolveBundledPluginSources({
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  return findBundledPluginSourceInMap({
    bundled,
    lookup: params.lookup,
  });
}

export function resolveBundledPluginInstallCommandHint(params: {
  pluginId: string;
  workspaceDir?: string;
  /** Use an explicit env when bundled roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
}): string | null {
  const bundledSource = findBundledPluginSource({
    lookup: { kind: "pluginId", value: params.pluginId },
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  if (!bundledSource?.localPath) {
    return null;
  }
  return `openclaw plugins install ${bundledSource.localPath}`;
}

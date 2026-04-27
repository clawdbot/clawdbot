import { normalizeOptionalString } from "../shared/string-coerce.js";
import { discoverOpenClawPlugins } from "./discovery.js";
import { loadPluginManifest } from "./manifest.js";

export type BundledPluginSource = {
  pluginId: string;
  localPath: string;
  npmSpec?: string;
  configSchema?: Record<string, unknown>;
  requiresConfig?: boolean;
};

export type BundledPluginLookup =
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
    if (source.npmSpec === targetValue) {
      return source;
    }
  }
  return undefined;
}

export function resolveBundledPluginSources(params: {
  workspaceDir?: string;
  /** Use an explicit env when bundled roots should resolve independently from process.env. */
  env?: NodeJS.ProcessEnv;
}): Map<string, BundledPluginSource> {
  const discovery = discoverOpenClawPlugins({
    workspaceDir: params.workspaceDir,
    env: params.env,
  });
  const bundled = new Map<string, BundledPluginSource>();

  for (const candidate of discovery.candidates) {
    if (candidate.origin !== "bundled") {
      continue;
    }
    const manifest = loadPluginManifest(candidate.rootDir, false);
    if (!manifest.ok) {
      continue;
    }
    const pluginId = manifest.manifest.id;
    if (bundled.has(pluginId)) {
      continue;
    }

    const npmSpec =
      normalizeOptionalString(candidate.packageManifest?.install?.npmSpec) ||
      normalizeOptionalString(candidate.packageName) ||
      undefined;

    bundled.set(pluginId, {
      pluginId,
      localPath: candidate.rootDir,
      npmSpec,
      ...(isRecord(manifest.manifest.configSchema)
        ? { configSchema: manifest.manifest.configSchema }
        : {}),
      requiresConfig: pluginConfigSchemaHasRequiredFields(manifest.manifest.configSchema),
    });
  }

  return bundled;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

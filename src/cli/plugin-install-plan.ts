import type { BundledPluginSource } from "../plugins/bundled-sources.js";
import { PLUGIN_INSTALL_ERROR_CODE } from "../plugins/install.js";
import { shortenHomePath } from "../utils.js";

type BundledLookup = (params: {
  kind: "pluginId" | "npmSpec";
  value: string;
}) => BundledPluginSource | undefined;

type OfficialExternalPluginLookup = (pluginId: string) =>
  | {
      pluginId: string;
      npmSpec?: string;
      expectedIntegrity?: string;
    }
  | undefined;

function isBareNpmPackageName(spec: string): boolean {
  const trimmed = spec.trim();
  return /^[a-z0-9][a-z0-9-._~]*$/.test(trimmed);
}

export function resolveBundledInstallPlanForCatalogEntry(params: {
  pluginId: string;
  npmSpec: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource } | null {
  const pluginId = params.pluginId.trim();
  const npmSpec = params.npmSpec.trim();
  if (!pluginId || !npmSpec) {
    return null;
  }

  const bundledBySpec = params.findBundledSource({
    kind: "npmSpec",
    value: npmSpec,
  });
  if (bundledBySpec?.pluginId === pluginId) {
    return { bundledSource: bundledBySpec };
  }

  const bundledById = params.findBundledSource({
    kind: "pluginId",
    value: pluginId,
  });
  if (bundledById?.pluginId !== pluginId) {
    return null;
  }
  if (bundledById.npmSpec && bundledById.npmSpec !== npmSpec) {
    return null;
  }

  return { bundledSource: bundledById };
}

export function resolveBundledInstallPlanBeforeNpm(params: {
  rawSpec: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource; warning: string } | null {
  if (!isBareNpmPackageName(params.rawSpec)) {
    return null;
  }
  const bundledSource = params.findBundledSource({
    kind: "pluginId",
    value: params.rawSpec,
  });
  if (!bundledSource) {
    return null;
  }
  return {
    bundledSource,
    warning: `Using bundled plugin "${bundledSource.pluginId}" from ${shortenHomePath(bundledSource.localPath)} for bare install spec "${params.rawSpec}". To install an npm package with the same name, use a scoped package name (for example @scope/${params.rawSpec}).`,
  };
}

export function resolveOfficialExternalInstallPlanBeforeNpm(params: {
  rawSpec: string;
  findOfficialExternalPlugin: OfficialExternalPluginLookup;
}): { pluginId: string; npmSpec: string; expectedIntegrity?: string } | null {
  if (!isBareNpmPackageName(params.rawSpec)) {
    return null;
  }
  const entry = params.findOfficialExternalPlugin(params.rawSpec);
  const npmSpec = entry?.npmSpec?.trim();
  if (!entry?.pluginId || !npmSpec) {
    return null;
  }
  return {
    pluginId: entry.pluginId,
    npmSpec,
    ...(entry.expectedIntegrity ? { expectedIntegrity: entry.expectedIntegrity } : {}),
  };
}

export function resolveBundledInstallPlanForNpmFailure(params: {
  rawSpec: string;
  code?: string;
  findBundledSource: BundledLookup;
}): { bundledSource: BundledPluginSource; warning: string } | null {
  if (params.code !== PLUGIN_INSTALL_ERROR_CODE.NPM_PACKAGE_NOT_FOUND) {
    return null;
  }
  const bundledSource = params.findBundledSource({
    kind: "npmSpec",
    value: params.rawSpec,
  });
  if (!bundledSource) {
    return null;
  }
  return {
    bundledSource,
    warning: `npm package unavailable for ${params.rawSpec}; using bundled plugin at ${shortenHomePath(bundledSource.localPath)}.`,
  };
}

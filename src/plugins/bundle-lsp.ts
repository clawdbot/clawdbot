import fs from "node:fs";
import path from "node:path";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { readRootJsonObjectSync } from "../infra/json-files.js";
import { isRecord } from "../utils.js";
import {
  inspectBundleServerRuntimeSupport,
  loadEnabledBundleConfig,
  readBundleJsonObject,
} from "./bundle-config-shared.js";
import {
  CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
  mergeBundlePathLists,
  normalizeBundlePathList,
} from "./bundle-manifest.js";
import type { PluginBundleFormat } from "./manifest-types.js";

export type BundleLspServerConfig = Record<string, unknown>;

export type BundleLspConfig = {
  lspServers: Record<string, BundleLspServerConfig>;
};

export type BundleLspRuntimeSupport = {
  hasStdioServer: boolean;
  supportedServerNames: string[];
  unsupportedServerNames: string[];
  diagnostics: string[];
};

const MANIFEST_PATH_BY_FORMAT: Partial<Record<PluginBundleFormat, string>> = {
  claude: CLAUDE_BUNDLE_MANIFEST_RELATIVE_PATH,
};

function extractLspServerMap(raw: unknown): Record<string, BundleLspServerConfig> {
  if (!isRecord(raw)) {
    return {};
  }
  const nested = isRecord(raw.lspServers) ? raw.lspServers : raw;
  if (!isRecord(nested)) {
    return {};
  }
  const result: Record<string, BundleLspServerConfig> = {};
  for (const [serverName, serverRaw] of Object.entries(nested)) {
    if (!isRecord(serverRaw)) {
      continue;
    }
    result[serverName] = { ...serverRaw };
  }
  return result;
}

function resolveBundleLspConfigPaths(params: {
  raw: Record<string, unknown>;
  rootDir: string;
}): string[] {
  const declared = normalizeBundlePathList(params.raw.lspServers);
  const defaults = fs.existsSync(path.join(params.rootDir, ".lsp.json")) ? [".lsp.json"] : [];
  return mergeBundlePathLists(defaults, declared);
}

function loadBundleLspConfigFile(params: { rootDir: string; relativePath: string }): {
  config: BundleLspConfig;
  diagnostics: string[];
} {
  const result = readRootJsonObjectSync({
    rootDir: params.rootDir,
    relativePath: params.relativePath,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!result.ok) {
    if (result.reason === "open") {
      return {
        config: { lspServers: {} },
        diagnostics:
          result.failure.reason === "path"
            ? []
            : [`unable to read ${params.relativePath}: ${result.failure.reason}`],
      };
    }
    return {
      config: { lspServers: {} },
      diagnostics: [`unable to read ${params.relativePath}: ${result.error}`],
    };
  }
  return { config: { lspServers: extractLspServerMap(result.value) }, diagnostics: [] };
}

function loadBundleLspConfig(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): { config: BundleLspConfig; diagnostics: string[] } {
  const manifestRelativePath = MANIFEST_PATH_BY_FORMAT[params.bundleFormat];
  if (!manifestRelativePath) {
    return { config: { lspServers: {} }, diagnostics: [] };
  }

  const manifestLoaded = readBundleJsonObject({
    rootDir: params.rootDir,
    relativePath: manifestRelativePath,
  });
  if (!manifestLoaded.ok) {
    return { config: { lspServers: {} }, diagnostics: [manifestLoaded.error] };
  }

  let merged: BundleLspConfig = { lspServers: {} };
  const filePaths = resolveBundleLspConfigPaths({
    raw: manifestLoaded.raw,
    rootDir: params.rootDir,
  });
  const diagnostics: string[] = [];
  for (const relativePath of filePaths) {
    const loaded = loadBundleLspConfigFile({
      rootDir: params.rootDir,
      relativePath,
    });
    diagnostics.push(...loaded.diagnostics);
    merged = applyMergePatch(merged, loaded.config) as BundleLspConfig;
  }

  return { config: merged, diagnostics };
}

export function inspectBundleLspRuntimeSupport(params: {
  pluginId: string;
  rootDir: string;
  bundleFormat: PluginBundleFormat;
}): BundleLspRuntimeSupport {
  const support = inspectBundleServerRuntimeSupport({
    loaded: loadBundleLspConfig(params),
    resolveServers: (config) => config.lspServers,
  });
  return {
    hasStdioServer: support.hasSupportedServer,
    supportedServerNames: support.supportedServerNames,
    unsupportedServerNames: support.unsupportedServerNames,
    diagnostics: support.diagnostics,
  };
}

export function loadEnabledBundleLspConfig(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
}): { config: BundleLspConfig; diagnostics: Array<{ pluginId: string; message: string }> } {
  return loadEnabledBundleConfig({
    workspaceDir: params.workspaceDir,
    cfg: params.cfg,
    createEmptyConfig: () => ({ lspServers: {} }),
    loadBundleConfig: loadBundleLspConfig,
    createDiagnostic: (pluginId, message) => ({ pluginId, message }),
  });
}

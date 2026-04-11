import fs from "node:fs";
import path from "node:path";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { openBoundaryFileSync } from "../infra/boundary-file-read.js";
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
import type { PluginBundleFormat } from "./types.js";

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

function loadBundleLspConfigFile(params: {
  rootDir: string;
  relativePath: string;
}): BundleLspConfig {
  const absolutePath = path.resolve(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    return { lspServers: {} };
  }
  try {
    const stat = fs.fstatSync(opened.fd);
    if (!stat.isFile()) {
      return { lspServers: {} };
    }
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    return { lspServers: extractLspServerMap(raw) };
  } finally {
    fs.closeSync(opened.fd);
  }
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
  for (const relativePath of filePaths) {
    merged = applyMergePatch(
      merged,
      loadBundleLspConfigFile({
        rootDir: params.rootDir,
        relativePath,
      }),
    ) as BundleLspConfig;
  }

  return { config: merged, diagnostics: [] };
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

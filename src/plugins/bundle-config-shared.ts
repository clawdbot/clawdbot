import fs from "node:fs";
import path from "node:path";
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { matchBoundaryFileOpenFailure, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import { loadPluginManifestRegistry } from "./manifest-registry.js";
import type { PluginBundleFormat } from "./manifest-types.js";

type ReadBundleJsonResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string };

export type BundleServerRuntimeSupport = {
  hasSupportedServer: boolean;
  supportedServerNames: string[];
  unsupportedServerNames: string[];
  diagnostics: string[];
};

export function readBundleJsonObject(params: {
  rootDir: string;
  relativePath: string;
  onOpenFailure?: (
    failure: Extract<ReturnType<typeof openBoundaryFileSync>, { ok: false }>,
  ) => ReadBundleJsonResult;
}): ReadBundleJsonResult {
  const absolutePath = path.join(params.rootDir, params.relativePath);
  const opened = openBoundaryFileSync({
    absolutePath,
    rootPath: params.rootDir,
    boundaryLabel: "plugin root",
    rejectHardlinks: true,
  });
  if (!opened.ok) {
    return params.onOpenFailure?.(opened) ?? { ok: true, raw: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(opened.fd, "utf-8")) as unknown;
    if (!isRecord(raw)) {
      return { ok: false, error: `${params.relativePath} must contain a JSON object` };
    }
    return { ok: true, raw };
  } catch (error) {
    return { ok: false, error: `failed to parse ${params.relativePath}: ${String(error)}` };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function resolveBundleJsonOpenFailure(params: {
  failure: Extract<ReturnType<typeof openBoundaryFileSync>, { ok: false }>;
  relativePath: string;
  allowMissing?: boolean;
}): ReadBundleJsonResult {
  return matchBoundaryFileOpenFailure(params.failure, {
    path: () => {
      if (params.allowMissing) {
        return { ok: true, raw: {} };
      }
      return { ok: false, error: `unable to read ${params.relativePath}: path` };
    },
    fallback: (failure) => ({
      ok: false,
      error: `unable to read ${params.relativePath}: ${failure.reason}`,
    }),
  });
}

export function inspectBundleServerRuntimeSupport<TConfig>(params: {
  loaded: { config: TConfig; diagnostics: string[] };
  resolveServers: (config: TConfig) => Record<string, Record<string, unknown>>;
}): BundleServerRuntimeSupport {
  const supportedServerNames: string[] = [];
  const unsupportedServerNames: string[] = [];
  let hasSupportedServer = false;
  for (const [serverName, server] of Object.entries(params.resolveServers(params.loaded.config))) {
    if (typeof server.command === "string" && server.command.trim().length > 0) {
      hasSupportedServer = true;
      supportedServerNames.push(serverName);
      continue;
    }
    unsupportedServerNames.push(serverName);
  }
  return {
    hasSupportedServer,
    supportedServerNames,
    unsupportedServerNames,
    diagnostics: params.loaded.diagnostics,
  };
}

export function loadEnabledBundleConfig<TConfig, TDiagnostic>(params: {
  workspaceDir: string;
  cfg?: OpenClawConfig;
  createEmptyConfig: () => TConfig;
  loadBundleConfig: (params: {
    pluginId: string;
    rootDir: string;
    bundleFormat: PluginBundleFormat;
  }) => { config: TConfig; diagnostics: string[] };
  createDiagnostic: (pluginId: string, message: string) => TDiagnostic;
}): { config: TConfig; diagnostics: TDiagnostic[] } {
  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
  if (!normalizedPlugins.enabled) {
    return { config: params.createEmptyConfig(), diagnostics: [] };
  }

  const registry = loadPluginManifestRegistry({
    workspaceDir: params.workspaceDir,
    config: params.cfg,
  });
  const diagnostics: TDiagnostic[] = [];
  let merged = params.createEmptyConfig();

  for (const record of registry.plugins) {
    if (record.format !== "bundle" || !record.bundleFormat) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      config: normalizedPlugins,
      rootConfig: params.cfg,
    });
    if (!activationState.activated) {
      continue;
    }

    const loaded = params.loadBundleConfig({
      pluginId: record.id,
      rootDir: record.rootDir,
      bundleFormat: record.bundleFormat,
    });
    merged = applyMergePatch(merged, loaded.config) as TConfig;
    for (const message of loaded.diagnostics) {
      diagnostics.push(params.createDiagnostic(record.id, message));
    }
  }

  return { config: merged, diagnostics };
}

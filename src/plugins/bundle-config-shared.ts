// Shares bundled plugin config merge behavior across setup and runtime code.
import { applyMergePatch } from "../config/merge-patch.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { matchRootFileOpenFailure, type RootFileOpenFailure } from "../infra/boundary-file-read.js";
import { isRecord } from "../utils.js";
import { normalizePluginsConfig, resolveEffectivePluginActivationState } from "./config-state.js";
import type { PluginManifestRecord, PluginManifestRegistry } from "./manifest-registry.js";
import type { PluginBundleFormat } from "./manifest-types.js";
import { parsePluginCacheJson, readPluginCacheFile } from "./plugin-cache-files.js";
import { loadPluginManifestRegistryForPluginRegistry } from "./plugin-registry.js";

type ReadBundleJsonResult =
  | { ok: true; raw: Record<string, unknown> }
  | { ok: false; error: string; reason?: "open" };

type BundleServerRuntimeSupport = {
  hasSupportedServer: boolean;
  supportedServerNames: string[];
  unsupportedServerNames: string[];
  diagnostics: string[];
};

export function readBundleJsonObject(params: {
  rootDir: string;
  relativePath: string;
  onOpenFailure?: (failure: RootFileOpenFailure) => ReadBundleJsonResult;
}): ReadBundleJsonResult {
  const file = readPluginCacheFile({
    rootDir: params.rootDir,
    relativePath: params.relativePath,
    rejectHardlinks: true,
    maxBytes: null,
  });
  if (!file.ok && file.failurePhase !== "read") {
    const result = params.onOpenFailure?.(file.failure) ?? { ok: true as const, raw: {} };
    return result.ok ? result : { ...result, reason: "open" };
  }
  const parsed = file.ok
    ? parsePluginCacheJson(file)
    : { ok: false as const, error: file.failure.error };
  if (!parsed.ok) {
    return { ok: false, error: `failed to parse ${params.relativePath}: ${String(parsed.error)}` };
  }
  return isRecord(parsed.value)
    ? { ok: true, raw: structuredClone(parsed.value) }
    : { ok: false, error: `${params.relativePath} must contain a JSON object` };
}

export function resolveBundleJsonOpenFailure(params: {
  failure: RootFileOpenFailure;
  relativePath: string;
  allowMissing?: boolean;
}): ReadBundleJsonResult {
  return matchRootFileOpenFailure(params.failure, {
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
  manifestRegistry?: Pick<PluginManifestRegistry, "plugins">;
  createEmptyConfig: () => TConfig;
  loadBundleConfig: (params: {
    pluginId: string;
    rootDir: string;
    bundleFormat: PluginBundleFormat;
  }) => { config: TConfig; diagnostics: string[] };
  loadNativePluginConfig?: (params: {
    record: PluginManifestRecord;
  }) => { config: TConfig; diagnostics: string[] } | undefined;
  createDiagnostic: (pluginId: string, message: string) => TDiagnostic;
}): { config: TConfig; diagnostics: TDiagnostic[] } {
  const normalizedPlugins = normalizePluginsConfig(params.cfg?.plugins);
  if (!normalizedPlugins.enabled) {
    return { config: params.createEmptyConfig(), diagnostics: [] };
  }

  const registry =
    params.manifestRegistry ??
    loadPluginManifestRegistryForPluginRegistry({
      workspaceDir: params.workspaceDir,
      config: params.cfg,
      includeDisabled: true,
    });
  const diagnostics: TDiagnostic[] = [];
  let merged = params.createEmptyConfig();

  for (const record of registry.plugins) {
    const canLoadBundle = record.format === "bundle" && Boolean(record.bundleFormat);
    const canLoadNative = record.format !== "bundle" && params.loadNativePluginConfig !== undefined;
    if (!canLoadBundle && !canLoadNative) {
      continue;
    }
    const activationState = resolveEffectivePluginActivationState({
      id: record.id,
      origin: record.origin,
      channelIds: record.channels,
      config: normalizedPlugins,
      rootConfig: params.cfg,
      enabledByDefault: record.enabledByDefault,
    });
    if (!activationState.activated) {
      continue;
    }

    const loaded =
      canLoadBundle && record.bundleFormat
        ? params.loadBundleConfig({
            pluginId: record.id,
            rootDir: record.rootDir,
            bundleFormat: record.bundleFormat,
          })
        : params.loadNativePluginConfig?.({ record });
    if (!loaded) {
      continue;
    }
    merged = applyMergePatch(merged, loaded.config) as TConfig;
    for (const message of loaded.diagnostics) {
      diagnostics.push(params.createDiagnostic(record.id, message));
    }
  }

  return { config: merged, diagnostics };
}

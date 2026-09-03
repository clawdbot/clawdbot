import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { resolveUserPath } from "../utils.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "./config-state.js";
import {
  getExternalizedBundledPluginLegacyPathSuffix,
  getExternalizedBundledPluginLookupIds,
  type ExternalizedBundledPluginBridge,
} from "./externalized-bundled-plugins.js";
import { resolveDefaultPluginExtensionsDir } from "./install-paths.js";
import { resolvePluginInstallDir } from "./install.js";
import { resolvePackageExtensionEntries, type PackageManifest } from "./manifest.js";
import { validatePackageExtensionEntriesForInstall } from "./package-entry-resolution.js";
import { reconcileRegisteredOpenClawHostLinks } from "./plugin-peer-link.js";
import { resetPluginSlotsToDefaults } from "./slots.js";
import { setPluginEnabledInConfig } from "./toggle-config.js";
import type { PluginUpdateLogger } from "./update-source.js";

export async function hasRunnableInstalledNpmPayload(params: {
  installPath: string;
  manifest: PackageManifest | undefined;
}): Promise<boolean> {
  const extensions = resolvePackageExtensionEntries(params.manifest);
  if (extensions.status !== "ok") {
    return false;
  }
  const validation = await validatePackageExtensionEntriesForInstall({
    packageDir: params.installPath,
    extensions: extensions.entries,
    manifest: params.manifest ?? {},
  });
  return validation.ok;
}

export function userPathsEqual(
  left: string | undefined,
  right: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (!left || !right) {
    return false;
  }
  return resolveUserPath(left, env) === resolveUserPath(right, env);
}

export function resolveRecordedExtensionsDir(params: {
  pluginId: string;
  installPath: string;
}): string | undefined {
  const parentDir = path.dirname(params.installPath);
  try {
    const canonicalInstallPath = resolvePluginInstallDir(params.pluginId, parentDir);
    return userPathsEqual(canonicalInstallPath, params.installPath) ? parentDir : undefined;
  } catch {
    return undefined;
  }
}

export function buildLoadPathHelpers(existing: string[], env: NodeJS.ProcessEnv = process.env) {
  let paths = [...existing];
  const resolveSet = () => new Set(paths.map((entry) => resolveUserPath(entry, env)));
  let resolved = resolveSet();
  let changed = false;

  const addPath = (value: string) => {
    const normalized = resolveUserPath(value, env);
    if (resolved.has(normalized)) {
      return;
    }
    paths.push(value);
    resolved.add(normalized);
    changed = true;
  };

  const removePath = (value: string) => {
    const normalized = resolveUserPath(value, env);
    if (!resolved.has(normalized)) {
      return;
    }
    paths = paths.filter((entry) => resolveUserPath(entry, env) !== normalized);
    resolved = resolveSet();
    changed = true;
  };

  const removeMatching = (predicate: (value: string) => boolean) => {
    const next = paths.filter((entry) => !predicate(entry));
    if (next.length === paths.length) {
      return;
    }
    paths = next;
    resolved = resolveSet();
    changed = true;
  };

  return {
    addPath,
    removePath,
    removeMatching,
    get changed() {
      return changed;
    },
    get paths() {
      return paths;
    },
  };
}

function normalizePathSegment(value: string | undefined): string {
  return (
    value
      ?.trim()
      .replaceAll("\\", "/")
      .replace(/^\/+|\/+$/g, "") ?? ""
  );
}

function pathEndsWithSegment(params: {
  value: string | undefined;
  segment: string | undefined;
  env: NodeJS.ProcessEnv;
}): boolean {
  const value = normalizePathSegment(params.value ? resolveUserPath(params.value, params.env) : "");
  const segment = normalizePathSegment(params.segment);
  return Boolean(value && segment && (value === segment || value.endsWith(`/${segment}`)));
}

export function isBridgeBundledPathRecord(params: {
  bridge: ExternalizedBundledPluginBridge;
  bundledLocalPath?: string;
  record: PluginInstallRecord;
  env: NodeJS.ProcessEnv;
}): boolean {
  if (params.record.source !== "path") {
    return false;
  }
  if (
    params.bundledLocalPath &&
    (userPathsEqual(params.record.sourcePath, params.bundledLocalPath, params.env) ||
      userPathsEqual(params.record.installPath, params.bundledLocalPath, params.env))
  ) {
    return true;
  }
  const bundledPathSuffix = getExternalizedBundledPluginLegacyPathSuffix(params.bridge);
  return (
    pathEndsWithSegment({
      value: params.record.sourcePath,
      segment: bundledPathSuffix,
      env: params.env,
    }) ||
    pathEndsWithSegment({
      value: params.record.installPath,
      segment: bundledPathSuffix,
      env: params.env,
    })
  );
}

export function removeBridgeBundledLoadPaths(params: {
  bridge: ExternalizedBundledPluginBridge;
  loadPaths: ReturnType<typeof buildLoadPathHelpers>;
  env: NodeJS.ProcessEnv;
}) {
  const bundledPathSuffix = getExternalizedBundledPluginLegacyPathSuffix(params.bridge);
  params.loadPaths.removeMatching((entry) =>
    pathEndsWithSegment({
      value: entry,
      segment: bundledPathSuffix,
      env: params.env,
    }),
  );
}

export function resolveBridgeInstallRecord(params: {
  installs: Record<string, PluginInstallRecord>;
  bridge: ExternalizedBundledPluginBridge;
}): { pluginId: string; record: PluginInstallRecord } | undefined {
  for (const pluginId of getExternalizedBundledPluginLookupIds(params.bridge)) {
    if (!Object.hasOwn(params.installs, pluginId)) {
      continue;
    }
    const record = params.installs[pluginId];
    if (record) {
      return { pluginId, record };
    }
  }
  return undefined;
}

function isBridgeChannelEnabledByConfig(params: {
  config: OpenClawConfig;
  bridge: ExternalizedBundledPluginBridge;
}): boolean {
  const channels = params.config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  for (const channelId of params.bridge.channelIds ?? []) {
    const entry = (channels as Record<string, unknown>)[channelId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      continue;
    }
    if (Object.is((entry as Record<string, unknown>).enabled, true)) {
      return true;
    }
  }
  return false;
}

export function isExternalizedBundledPluginEnabled(params: {
  config: OpenClawConfig;
  bridge: ExternalizedBundledPluginBridge;
}): boolean {
  const normalized = normalizePluginsConfig(params.config.plugins);
  if (!normalized.enabled) {
    return false;
  }
  const pluginIds = getExternalizedBundledPluginLookupIds(params.bridge);
  if (
    pluginIds.some(
      (pluginId) =>
        normalized.deny.includes(pluginId) ||
        Object.is(normalized.entries[pluginId]?.enabled, false),
    )
  ) {
    return false;
  }
  for (const pluginId of pluginIds) {
    if (
      resolveEffectiveEnableState({
        id: pluginId,
        origin: "bundled",
        config: normalized,
        rootConfig: params.config,
        enabledByDefault: params.bridge.enabledByDefault,
      }).enabled
    ) {
      return true;
    }
  }
  if (isBridgeChannelEnabledByConfig(params)) {
    return true;
  }
  return false;
}

function replacePluginIdInList(
  entries: string[] | undefined,
  fromId: string,
  toId: string,
): string[] | undefined {
  if (!entries || entries.length === 0 || fromId === toId || !entries.includes(fromId)) {
    return entries;
  }
  const next: string[] = [];
  for (const entry of entries) {
    const value = entry === fromId ? toId : entry;
    if (!next.includes(value)) {
      next.push(value);
    }
  }
  return next;
}

export function migratePluginConfigId(
  cfg: OpenClawConfig,
  fromId: string,
  toId: string,
): OpenClawConfig {
  const plugins = cfg.plugins;
  if (fromId === toId || !plugins) {
    return cfg;
  }

  let nextPlugins = plugins;
  const ensureNextPlugins = () => {
    if (nextPlugins === plugins) {
      nextPlugins = { ...plugins };
    }
    return nextPlugins;
  };

  const installs = plugins.installs;
  if (installs && Object.hasOwn(installs, fromId)) {
    const record = installs[fromId];
    const nextInstalls = { ...installs };
    if (record && !Object.hasOwn(installs, toId)) {
      // Plugin ids are record keys; define data properties so "__proto__" cannot invoke its setter.
      Object.defineProperty(nextInstalls, toId, {
        configurable: true,
        enumerable: true,
        value: record,
        writable: true,
      });
    }
    delete nextInstalls[fromId];
    ensureNextPlugins().installs = nextInstalls;
  }

  const entries = plugins.entries;
  if (entries && Object.hasOwn(entries, fromId)) {
    const entry = entries[fromId];
    const existingEntry = Object.hasOwn(entries, toId) ? entries[toId] : undefined;
    const nextEntries = { ...entries };
    if (entry) {
      Object.defineProperty(nextEntries, toId, {
        configurable: true,
        enumerable: true,
        value: existingEntry
          ? {
              ...entry,
              ...existingEntry,
            }
          : entry,
        writable: true,
      });
    }
    delete nextEntries[fromId];
    ensureNextPlugins().entries = nextEntries;
  }

  const allow = replacePluginIdInList(plugins.allow, fromId, toId);
  if (allow !== plugins.allow) {
    ensureNextPlugins().allow = allow;
  }
  const deny = replacePluginIdInList(plugins.deny, fromId, toId);
  if (deny !== plugins.deny) {
    ensureNextPlugins().deny = deny;
  }

  const slots = plugins.slots;
  if (slots?.memory === fromId || slots?.contextEngine === fromId) {
    ensureNextPlugins().slots = {
      ...slots,
      ...(slots.memory === fromId ? { memory: toId } : {}),
      ...(slots.contextEngine === fromId ? { contextEngine: toId } : {}),
    };
  }

  return nextPlugins === plugins ? cfg : { ...cfg, plugins: nextPlugins };
}

export function disablePluginAfterUpdateFailure(
  config: OpenClawConfig,
  pluginId: string,
): OpenClawConfig {
  const disabled = setPluginEnabledInConfig(config, pluginId, false, {
    updateChannelConfig: false,
  });
  const pluginsConfig = disabled.plugins ?? {};
  return {
    ...disabled,
    plugins: {
      ...pluginsConfig,
      // Failed updates are reversible activation changes; only explicit uninstall removes trust policy.
      slots: resetPluginSlotsToDefaults(pluginsConfig.slots, pluginId),
    },
  };
}

/** Repairs a legacy npm-owned extensions-root host without reinstalling its package. */
export async function repairRegisteredOpenClawHostLink(params: {
  pluginId: string;
  record: PluginInstallRecord;
  logger: PluginUpdateLogger;
}): Promise<boolean> {
  const result = await reconcileRegisteredOpenClawHostLinks({
    installRecords: { [params.pluginId]: params.record },
    extensionsDir: resolveDefaultPluginExtensionsDir(),
    mode: "repair",
    logger: params.logger,
  });
  return result.repaired > 0;
}

export async function repairOpenClawPeerLinksForNpmInstalls(params: {
  config: OpenClawConfig;
  logger: PluginUpdateLogger;
}): Promise<boolean> {
  const result = await reconcileRegisteredOpenClawHostLinks({
    installRecords: params.config.plugins?.installs ?? {},
    extensionsDir: resolveDefaultPluginExtensionsDir(),
    mode: "repair",
    logger: params.logger,
    onPackageReadError: (error, packageDir) => {
      params.logger.warn?.(
        `Could not repair openclaw peer link at ${packageDir}: ${String(error)}`,
      );
    },
  });
  return result.repaired > 0;
}

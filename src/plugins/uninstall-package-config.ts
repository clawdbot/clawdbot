import { realpathSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resetPluginSlotsToDefaults } from "./slots.js";

export type PluginConfigUninstallActions = {
  entry: boolean;
  install: boolean;
  allowlist: boolean;
  denylist: boolean;
  loadPath: boolean;
  memorySlot: boolean;
  contextEngineSlot: boolean;
  channelConfig: boolean;
};

const SHARED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

function createEmptyConfigUninstallActions(): PluginConfigUninstallActions {
  return {
    entry: false,
    install: false,
    allowlist: false,
    denylist: false,
    loadPath: false,
    memorySlot: false,
    contextEngineSlot: false,
    channelConfig: false,
  };
}

export function resolveComparableUninstallPathInternal(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function isUninstallPathInsideOrEqualInternal(parent: string, child: string): boolean {
  const relative = path.relative(
    resolveComparableUninstallPathInternal(parent),
    resolveComparableUninstallPathInternal(child),
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveUninstallChannelConfigKeysInternal(
  pluginId: string,
  opts?: { channelIds?: string[] },
): string[] {
  const rawKeys = opts?.channelIds ?? [pluginId];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const key of rawKeys) {
    if (SHARED_CHANNEL_CONFIG_KEYS.has(key) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function loadPathMatchesInstallPath(loadPath: string, installPath: string): boolean {
  return (
    loadPath === installPath ||
    resolveComparableUninstallPathInternal(loadPath) ===
      resolveComparableUninstallPathInternal(installPath)
  );
}

export function hasMatchingPluginLoadPath(
  config: OpenClawConfig,
  ownedPaths: readonly string[],
): boolean {
  return Boolean(
    config.plugins?.load?.paths?.some((candidate) =>
      ownedPaths.some((ownedPath) => loadPathMatchesInstallPath(candidate, ownedPath)),
    ),
  );
}

function removeMatchingLoadPaths(
  load: NonNullable<OpenClawConfig["plugins"]>["load"],
  ownedPaths: readonly string[],
): { load: NonNullable<OpenClawConfig["plugins"]>["load"] | undefined; changed: boolean } {
  const loadPaths = load?.paths;
  if (
    ownedPaths.length === 0 ||
    !Array.isArray(loadPaths) ||
    !loadPaths.some((candidate) =>
      ownedPaths.some((ownedPath) => loadPathMatchesInstallPath(candidate, ownedPath)),
    )
  ) {
    return { load, changed: false };
  }
  const nextLoadPaths = loadPaths.filter(
    (candidate) =>
      !ownedPaths.some((ownedPath) => loadPathMatchesInstallPath(candidate, ownedPath)),
  );
  return {
    load: nextLoadPaths.length > 0 ? { ...load, paths: nextLoadPaths } : undefined,
    changed: true,
  };
}

export function removePluginRuntimePolicyFromConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  opts?: { channelIds?: string[]; loadPaths?: string[] },
): { config: OpenClawConfig; actions: PluginConfigUninstallActions } {
  const actions = createEmptyConfigUninstallActions();
  const pluginsConfig = cfg.plugins ?? {};

  let entries = pluginsConfig.entries;
  if (entries && Object.hasOwn(entries, pluginId)) {
    const { [pluginId]: _, ...rest } = entries;
    entries = Object.keys(rest).length > 0 ? rest : undefined;
    actions.entry = true;
  }

  let allow = pluginsConfig.allow;
  if (Array.isArray(allow) && allow.includes(pluginId)) {
    allow = allow.filter((id) => id !== pluginId);
    allow = allow.length > 0 ? allow : undefined;
    actions.allowlist = true;
  }

  let deny = pluginsConfig.deny;
  if (Array.isArray(deny) && deny.includes(pluginId)) {
    deny = deny.filter((id) => id !== pluginId);
    deny = deny.length > 0 ? deny : undefined;
    actions.denylist = true;
  }

  const loadResult = removeMatchingLoadPaths(pluginsConfig.load, opts?.loadPaths ?? []);
  actions.loadPath = loadResult.changed;

  let slots = pluginsConfig.slots;
  if (slots?.memory === pluginId) {
    actions.memorySlot = true;
  }
  if (slots?.contextEngine === pluginId) {
    actions.contextEngineSlot = true;
  }
  slots = resetPluginSlotsToDefaults(slots, pluginId);
  if (slots && Object.keys(slots).length === 0) {
    slots = undefined;
  }

  const cleanedPlugins = {
    ...pluginsConfig,
    entries,
    allow,
    deny,
    load: loadResult.load,
    slots,
  };
  for (const key of ["entries", "allow", "deny", "load", "slots"] as const) {
    if (cleanedPlugins[key] === undefined) {
      delete cleanedPlugins[key];
    }
  }

  let channels = cfg.channels as Record<string, unknown> | undefined;
  for (const key of resolveUninstallChannelConfigKeysInternal(pluginId, opts)) {
    if (!channels || !Object.hasOwn(channels, key)) {
      continue;
    }
    const { [key]: _removed, ...rest } = channels;
    channels = Object.keys(rest).length > 0 ? rest : undefined;
    actions.channelConfig = true;
  }

  if (!Object.values(actions).some(Boolean)) {
    return { config: cfg, actions };
  }
  return {
    config: {
      ...cfg,
      plugins: Object.keys(cleanedPlugins).length > 0 ? cleanedPlugins : undefined,
      channels: channels as OpenClawConfig["channels"],
    },
    actions,
  };
}

export function removePluginInstallOwnerFromConfig(
  cfg: OpenClawConfig,
  installOwner: string,
): { config: OpenClawConfig; actions: PluginConfigUninstallActions } {
  const actions = createEmptyConfigUninstallActions();
  const pluginsConfig = cfg.plugins ?? {};
  let installs = pluginsConfig.installs;
  const installRecord = Object.hasOwn(installs ?? {}, installOwner)
    ? installs?.[installOwner]
    : undefined;
  if (installs && installRecord) {
    const { [installOwner]: _, ...rest } = installs;
    installs = Object.keys(rest).length > 0 ? rest : undefined;
    actions.install = true;
  }
  const trackedPaths = [
    installRecord?.installPath,
    installRecord?.source === "path" ? installRecord.sourcePath : undefined,
  ].filter((value): value is string => Boolean(value));
  const loadResult = removeMatchingLoadPaths(pluginsConfig.load, trackedPaths);
  actions.loadPath = loadResult.changed;
  const cleanedPlugins = { ...pluginsConfig, installs, load: loadResult.load };
  for (const key of ["installs", "load"] as const) {
    if (cleanedPlugins[key] === undefined) {
      delete cleanedPlugins[key];
    }
  }
  if (!Object.values(actions).some(Boolean)) {
    return { config: cfg, actions };
  }
  return {
    config: {
      ...cfg,
      plugins: Object.keys(cleanedPlugins).length > 0 ? cleanedPlugins : undefined,
    },
    actions,
  };
}

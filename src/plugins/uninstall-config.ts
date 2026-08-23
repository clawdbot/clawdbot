// Pure plugin config cleanup shared by doctor repair and full uninstall flows.
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

/** Resolve a path through existing ancestors while preserving missing targets. */
export function resolveComparableUninstallPath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** Check whether a managed uninstall target stays inside its owning root. */
export function isUninstallPathInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(
    resolveComparableUninstallPath(parent),
    resolveComparableUninstallPath(child),
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve channel config keys owned by a plugin during uninstall. */
export function resolveUninstallChannelConfigKeys(
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
    resolveComparableUninstallPath(loadPath) === resolveComparableUninstallPath(installPath)
  );
}

/** Remove plugin references from config without loading uninstall process/runtime dependencies. */
export function removePluginFromConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  opts?: { channelIds?: string[] },
): { config: OpenClawConfig; actions: PluginConfigUninstallActions } {
  const actions = createEmptyConfigUninstallActions();
  const pluginsConfig = cfg.plugins ?? {};

  let entries = pluginsConfig.entries;
  if (entries && Object.hasOwn(entries, pluginId)) {
    const { [pluginId]: _, ...rest } = entries;
    entries = Object.keys(rest).length > 0 ? rest : undefined;
    actions.entry = true;
  }

  let installs = pluginsConfig.installs;
  const hasInstallRecord = Object.hasOwn(installs ?? {}, pluginId);
  const installRecord = hasInstallRecord ? installs?.[pluginId] : undefined;
  if (installs && hasInstallRecord) {
    const { [pluginId]: _, ...rest } = installs;
    installs = Object.keys(rest).length > 0 ? rest : undefined;
    actions.install = true;
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

  let load = pluginsConfig.load;
  const trackedInstallPaths = [
    installRecord?.installPath,
    installRecord?.source === "path" ? installRecord.sourcePath : undefined,
  ].filter((value): value is string => Boolean(value));
  if (trackedInstallPaths.length > 0) {
    const loadPaths = load?.paths;
    if (
      Array.isArray(loadPaths) &&
      loadPaths.some((candidate) =>
        trackedInstallPaths.some((installPath) =>
          loadPathMatchesInstallPath(candidate, installPath),
        ),
      )
    ) {
      const nextLoadPaths = loadPaths.filter(
        (candidate) =>
          !trackedInstallPaths.some((installPath) =>
            loadPathMatchesInstallPath(candidate, installPath),
          ),
      );
      load = nextLoadPaths.length > 0 ? { ...load, paths: nextLoadPaths } : undefined;
      actions.loadPath = true;
    }
  }

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
    installs,
    allow,
    deny,
    load,
    slots,
  };
  for (const key of ["entries", "installs", "allow", "deny", "load", "slots"] as const) {
    if (cleanedPlugins[key] === undefined) {
      delete cleanedPlugins[key];
    }
  }

  let channels = cfg.channels as Record<string, unknown> | undefined;
  if (hasInstallRecord && channels) {
    for (const key of resolveUninstallChannelConfigKeys(pluginId, opts)) {
      if (!Object.hasOwn(channels, key)) {
        continue;
      }
      const { [key]: _removed, ...rest } = channels;
      channels = Object.keys(rest).length > 0 ? rest : undefined;
      actions.channelConfig = true;
      if (!channels) {
        break;
      }
    }
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

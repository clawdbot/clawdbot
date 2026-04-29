import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginInstallRecord } from "../config/types.plugins.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolvePluginInstallDir } from "./install.js";
import { defaultSlotIdForKey } from "./slots.js";

export type UninstallActions = {
  entry: boolean;
  install: boolean;
  allowlist: boolean;
  denylist: boolean;
  loadPath: boolean;
  memorySlot: boolean;
  contextEngineSlot: boolean;
  channelConfig: boolean;
  directory: boolean;
};

export const UNINSTALL_ACTION_LABELS = {
  entry: "config entry",
  install: "install record",
  allowlist: "allowlist entry",
  denylist: "denylist entry",
  loadPath: "load path",
  memorySlot: "memory slot",
  contextEngineSlot: "context engine slot",
  channelConfig: "channel config",
  directory: "directory",
} satisfies Record<keyof UninstallActions, string>;

const UNINSTALL_ACTION_ORDER = [
  "entry",
  "install",
  "allowlist",
  "denylist",
  "loadPath",
  "memorySlot",
  "contextEngineSlot",
  "channelConfig",
  "directory",
] as const satisfies ReadonlyArray<keyof UninstallActions>;

export function createEmptyUninstallActions(
  overrides: Partial<UninstallActions> = {},
): UninstallActions {
  return {
    entry: false,
    install: false,
    allowlist: false,
    denylist: false,
    loadPath: false,
    memorySlot: false,
    contextEngineSlot: false,
    channelConfig: false,
    directory: false,
    ...overrides,
  };
}

export function createEmptyConfigUninstallActions(): Omit<UninstallActions, "directory"> {
  const { directory: _directory, ...actions } = createEmptyUninstallActions();
  return actions;
}

export function formatUninstallActionLabels(actions: UninstallActions): string[] {
  return UNINSTALL_ACTION_ORDER.flatMap((key) =>
    actions[key] ? [UNINSTALL_ACTION_LABELS[key]] : [],
  );
}

export function formatUninstallSlotResetPreview(slotKey: "memory" | "contextEngine"): string {
  const actionKey = slotKey === "memory" ? "memorySlot" : "contextEngineSlot";
  return `${UNINSTALL_ACTION_LABELS[actionKey]} (will reset to "${defaultSlotIdForKey(slotKey)}")`;
}

export type UninstallPluginResult =
  | {
      ok: true;
      config: OpenClawConfig;
      pluginId: string;
      actions: UninstallActions;
      warnings: string[];
    }
  | { ok: false; error: string };

export type PluginUninstallDirectoryRemoval = {
  target: string;
};

export type PluginUninstallPlanResult =
  | {
      ok: true;
      config: OpenClawConfig;
      pluginId: string;
      actions: UninstallActions;
      directoryRemoval: PluginUninstallDirectoryRemoval | null;
    }
  | { ok: false; error: string };

export function resolveUninstallDirectoryTarget(params: {
  pluginId: string;
  hasInstall: boolean;
  installRecord?: PluginInstallRecord;
  extensionsDir?: string;
}): string | null {
  if (!params.hasInstall) {
    return null;
  }

  if (isLinkedPathInstallRecord(params.installRecord)) {
    return null;
  }

  let defaultPath: string;
  try {
    defaultPath = resolvePluginInstallDir(params.pluginId, params.extensionsDir);
  } catch {
    return null;
  }

  const configuredPath = params.installRecord?.installPath;
  if (!configuredPath) {
    return defaultPath;
  }

  if (path.resolve(configuredPath) === path.resolve(defaultPath)) {
    return configuredPath;
  }

  if (params.extensionsDir && isPathInsideOrEqual(params.extensionsDir, configuredPath)) {
    return configuredPath;
  }

  const recordedManagedPath = resolveRecordedManagedInstallPath({
    pluginId: params.pluginId,
    installPath: configuredPath,
  });
  if (recordedManagedPath) {
    return recordedManagedPath;
  }

  // Never trust configured installPath blindly for recursive deletes outside
  // the managed extensions directory.
  return defaultPath;
}

function resolveRecordedManagedInstallPath(params: {
  pluginId: string;
  installPath: string;
}): string | null {
  const resolvedInstallPath = path.resolve(params.installPath);
  const recordedExtensionsDir = path.dirname(resolvedInstallPath);
  if (path.basename(recordedExtensionsDir) !== "extensions") {
    return null;
  }

  try {
    const canonicalInstallPath = path.resolve(
      resolvePluginInstallDir(params.pluginId, recordedExtensionsDir),
    );
    return canonicalInstallPath === resolvedInstallPath ? params.installPath : null;
  } catch {
    return null;
  }
}

function isLinkedPathInstallRecord(installRecord: PluginInstallRecord | undefined): boolean {
  if (installRecord?.source !== "path") {
    return false;
  }
  if (!installRecord.sourcePath || !installRecord.installPath) {
    return true;
  }
  return (
    resolveComparablePath(installRecord.sourcePath) ===
    resolveComparablePath(installRecord.installPath)
  );
}

const SHARED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

/**
 * Resolve the channel config keys owned by a plugin during uninstall.
 * - `channelIds === undefined`: fall back to the plugin id for backward compatibility.
 * - `channelIds === []`: explicit "owns no channels" signal; remove nothing.
 */
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

function loadPathMatchesInstallSourcePath(loadPath: string, sourcePath: string): boolean {
  if (loadPath === sourcePath) {
    return true;
  }
  return resolveComparablePath(loadPath) === resolveComparablePath(sourcePath);
}

function resolveComparablePath(value: string): string {
  const resolved = path.resolve(value);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function isPathInsideOrEqual(parent: string, child: string): boolean {
  const relative = path.relative(resolveComparablePath(parent), resolveComparablePath(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Remove plugin references from config (pure config mutation).
 * Returns a new config with the plugin removed from entries, installs, allow, load.paths, slots,
 * and owned channel config.
 */
export function removePluginFromConfig(
  cfg: OpenClawConfig,
  pluginId: string,
  opts?: { channelIds?: string[] },
): { config: OpenClawConfig; actions: Omit<UninstallActions, "directory"> } {
  const actions = createEmptyConfigUninstallActions();

  const pluginsConfig = cfg.plugins ?? {};

  // Remove from entries
  let entries = pluginsConfig.entries;
  if (entries && pluginId in entries) {
    const { [pluginId]: _, ...rest } = entries;
    entries = Object.keys(rest).length > 0 ? rest : undefined;
    actions.entry = true;
  }

  // Remove from installs
  let installs = pluginsConfig.installs;
  const installRecord = installs?.[pluginId];
  if (installs && pluginId in installs) {
    const { [pluginId]: _, ...rest } = installs;
    installs = Object.keys(rest).length > 0 ? rest : undefined;
    actions.install = true;
  }

  // Remove from allowlist
  let allow = pluginsConfig.allow;
  if (Array.isArray(allow) && allow.includes(pluginId)) {
    allow = allow.filter((id) => id !== pluginId);
    if (allow.length === 0) {
      allow = undefined;
    }
    actions.allowlist = true;
  }

  // Remove from denylist. An explicit uninstall should clear stale policy so a
  // later reinstall can enable the plugin deterministically.
  let deny = pluginsConfig.deny;
  if (Array.isArray(deny) && deny.includes(pluginId)) {
    deny = deny.filter((id) => id !== pluginId);
    if (deny.length === 0) {
      deny = undefined;
    }
    actions.denylist = true;
  }

  // Remove linked path from load.paths (for source === "path" plugins)
  let load = pluginsConfig.load;
  if (installRecord?.source === "path" && installRecord.sourcePath) {
    const sourcePath = installRecord.sourcePath;
    const loadPaths = load?.paths;
    if (
      Array.isArray(loadPaths) &&
      loadPaths.some((p) => loadPathMatchesInstallSourcePath(p, sourcePath))
    ) {
      const nextLoadPaths = loadPaths.filter(
        (p) => !loadPathMatchesInstallSourcePath(p, sourcePath),
      );
      load = nextLoadPaths.length > 0 ? { ...load, paths: nextLoadPaths } : undefined;
      actions.loadPath = true;
    }
  }

  // Reset slots if this plugin was selected.
  let slots = pluginsConfig.slots;
  if (slots?.memory === pluginId) {
    slots = {
      ...slots,
      memory: defaultSlotIdForKey("memory"),
    };
    actions.memorySlot = true;
  }
  if (slots?.contextEngine === pluginId) {
    slots = {
      ...slots,
      contextEngine: defaultSlotIdForKey("contextEngine"),
    };
    actions.contextEngineSlot = true;
  }
  if (slots && Object.keys(slots).length === 0) {
    slots = undefined;
  }

  const newPlugins = {
    ...pluginsConfig,
    entries,
    installs,
    allow,
    deny,
    load,
    slots,
  };

  // Clean up undefined properties from newPlugins
  const cleanedPlugins: typeof newPlugins = { ...newPlugins };
  if (cleanedPlugins.entries === undefined) {
    delete cleanedPlugins.entries;
  }
  if (cleanedPlugins.installs === undefined) {
    delete cleanedPlugins.installs;
  }
  if (cleanedPlugins.allow === undefined) {
    delete cleanedPlugins.allow;
  }
  if (cleanedPlugins.deny === undefined) {
    delete cleanedPlugins.deny;
  }
  if (cleanedPlugins.load === undefined) {
    delete cleanedPlugins.load;
  }
  if (cleanedPlugins.slots === undefined) {
    delete cleanedPlugins.slots;
  }

  // Remove channel config owned by this installed plugin.
  // Built-in channels have no install record, so keep their config untouched.
  const hasInstallRecord = Object.hasOwn(cfg.plugins?.installs ?? {}, pluginId);
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

  const config: OpenClawConfig = {
    ...cfg,
    plugins: Object.keys(cleanedPlugins).length > 0 ? cleanedPlugins : undefined,
    channels: channels as OpenClawConfig["channels"],
  };

  return { config, actions };
}

export type UninstallPluginParams = {
  config: OpenClawConfig;
  pluginId: string;
  channelIds?: string[];
  deleteFiles?: boolean;
  extensionsDir?: string;
};

/**
 * Plan a plugin uninstall by removing it from config and resolving a safe file-removal target.
 * Linked path plugins never have their source directory deleted. Copied path installs still remove
 * their managed install directory.
 */
export function planPluginUninstall(params: UninstallPluginParams): PluginUninstallPlanResult {
  const { config, pluginId, channelIds, deleteFiles = true, extensionsDir } = params;

  // Validate plugin exists
  const hasEntry = pluginId in (config.plugins?.entries ?? {});
  const hasInstall = pluginId in (config.plugins?.installs ?? {});

  if (!hasEntry && !hasInstall) {
    return { ok: false, error: `Plugin not found: ${pluginId}` };
  }

  const installRecord = config.plugins?.installs?.[pluginId];
  const isLinked = isLinkedPathInstallRecord(installRecord);

  // Remove from config
  const { config: newConfig, actions: configActions } = removePluginFromConfig(config, pluginId, {
    channelIds,
  });

  const actions: UninstallActions = {
    ...configActions,
    directory: false,
  };

  const deleteTarget =
    deleteFiles && !isLinked
      ? resolveUninstallDirectoryTarget({
          pluginId,
          hasInstall,
          installRecord,
          extensionsDir,
        })
      : null;

  return {
    ok: true,
    config: newConfig,
    pluginId,
    actions,
    directoryRemoval: deleteTarget ? { target: deleteTarget } : null,
  };
}

export async function applyPluginUninstallDirectoryRemoval(
  removal: PluginUninstallDirectoryRemoval | null,
): Promise<{ directoryRemoved: boolean; warnings: string[] }> {
  if (!removal) {
    return { directoryRemoved: false, warnings: [] };
  }

  const existed =
    (await fs
      .access(removal.target)
      .then(() => true)
      .catch(() => false)) ?? false;
  try {
    await fs.rm(removal.target, { recursive: true, force: true });
    return { directoryRemoved: existed, warnings: [] };
  } catch (error) {
    return {
      directoryRemoved: false,
      warnings: [
        `Failed to remove plugin directory ${removal.target}: ${formatErrorMessage(error)}`,
      ],
    };
  }
}

export async function uninstallPlugin(
  params: UninstallPluginParams,
): Promise<UninstallPluginResult> {
  const plan = planPluginUninstall(params);
  if (!plan.ok) {
    return plan;
  }
  const directory = await applyPluginUninstallDirectoryRemoval(plan.directoryRemoval);
  return {
    ok: true,
    config: plan.config,
    pluginId: plan.pluginId,
    actions: {
      ...plan.actions,
      directory: directory.directoryRemoved,
    },
    warnings: directory.warnings,
  };
}

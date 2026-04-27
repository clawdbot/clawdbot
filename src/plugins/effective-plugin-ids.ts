import fs from "node:fs";
import path from "node:path";
import { listPotentialConfiguredChannelIds } from "../channels/config-presence.js";
import { applyPluginAutoEnable } from "../config/plugin-auto-enable.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeOptionalLowercaseString } from "../shared/string-coerce.js";
import { resolveBundledPluginsDir } from "./bundled-dir.js";
import {
  listExplicitConfiguredChannelIdsForConfig,
  resolveConfiguredChannelPluginIds,
  resolveGatewayStartupPluginIds,
} from "./channel-plugin-ids.js";
import { normalizePluginsConfig } from "./config-state.js";
import { loadPluginManifest } from "./manifest.js";

function listExplicitlyDisabledChannelIds(config: OpenClawConfig): Set<string> {
  const channels = config.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return new Set();
  }
  return new Set(
    Object.entries(channels)
      .filter(([, value]) => {
        return (
          value &&
          typeof value === "object" &&
          !Array.isArray(value) &&
          (value as { enabled?: unknown }).enabled === false
        );
      })
      .map(([channelId]) => normalizeOptionalLowercaseString(channelId))
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
}

function collectConfiguredChannelIds(
  config: OpenClawConfig,
  activationSourceConfig: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): string[] {
  const disabled = new Set([
    ...listExplicitlyDisabledChannelIds(config),
    ...listExplicitlyDisabledChannelIds(activationSourceConfig),
  ]);
  const ids = new Set([
    ...listPotentialConfiguredChannelIds(config, env, { includePersistedAuthState: false }),
    ...listExplicitConfiguredChannelIdsForConfig(activationSourceConfig),
  ]);
  return [...ids]
    .map((channelId) => normalizeOptionalLowercaseString(channelId))
    .filter((channelId): channelId is string => {
      if (!channelId) {
        return false;
      }
      return !disabled.has(channelId);
    })
    .toSorted((left, right) => left.localeCompare(right));
}

function collectBundledChannelOwnerPluginIds(params: {
  channelIds: readonly string[];
  env: NodeJS.ProcessEnv;
}): string[] {
  const channelIds = new Set(
    params.channelIds
      .map((channelId) => normalizeOptionalLowercaseString(channelId))
      .filter((channelId): channelId is string => Boolean(channelId)),
  );
  if (channelIds.size === 0) {
    return [];
  }
  const bundledDir = resolveBundledPluginsDir(params.env);
  if (!bundledDir) {
    return [];
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(bundledDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const pluginIds = new Set<string>();
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginDir = path.join(bundledDir, entry.name);
    const manifest = loadPluginManifest(pluginDir, false);
    if (!manifest.ok) {
      continue;
    }
    if (
      (manifest.manifest.channels ?? []).some((channelId) =>
        channelIds.has(normalizeOptionalLowercaseString(channelId) ?? ""),
      )
    ) {
      const pluginId = normalizeOptionalLowercaseString(manifest.manifest.id);
      if (pluginId) {
        pluginIds.add(pluginId);
      }
    }
  }
  return [...pluginIds].toSorted((left, right) => left.localeCompare(right));
}

function collectExplicitEffectivePluginIds(config: OpenClawConfig): string[] {
  const plugins = normalizePluginsConfig(config.plugins);
  if (!plugins.enabled) {
    return [];
  }

  const ids = new Set(plugins.allow);
  for (const [pluginId, entry] of Object.entries(plugins.entries)) {
    if (
      entry?.enabled === true &&
      (plugins.allow.length === 0 || plugins.allow.includes(pluginId))
    ) {
      ids.add(pluginId);
    }
  }
  for (const pluginId of plugins.deny) {
    ids.delete(pluginId);
  }
  for (const [pluginId, entry] of Object.entries(plugins.entries)) {
    if (entry?.enabled === false) {
      ids.delete(pluginId);
    }
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

export function resolveEffectivePluginIds(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  workspaceDir?: string;
}): string[] {
  const autoEnabled = applyPluginAutoEnable({
    config: params.config,
    env: params.env,
  });
  const effectiveConfig = autoEnabled.config;
  const ids = new Set(collectExplicitEffectivePluginIds(effectiveConfig));
  const configuredChannelIds = collectConfiguredChannelIds(
    effectiveConfig,
    params.config,
    params.env,
  );
  for (const pluginId of resolveConfiguredChannelPluginIds({
    config: effectiveConfig,
    activationSourceConfig: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })) {
    ids.add(pluginId);
  }
  for (const pluginId of collectBundledChannelOwnerPluginIds({
    channelIds: configuredChannelIds,
    env: params.env,
  })) {
    ids.add(pluginId);
  }
  for (const pluginId of resolveGatewayStartupPluginIds({
    config: effectiveConfig,
    activationSourceConfig: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env,
  })) {
    ids.add(pluginId);
  }
  return [...ids].toSorted((left, right) => left.localeCompare(right));
}

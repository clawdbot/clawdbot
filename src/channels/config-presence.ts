import fs from "node:fs";
import os from "node:os";
import {
  hasBundledChannelPersistedAuthState,
  listBundledChannelIdsWithPersistedAuthState,
} from "../channels/plugins/persisted-auth-state.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasNonEmptyString } from "../infra/outbound/channel-target.js";
import { isRecord } from "../utils.js";
import { listBundledChannelPluginIds } from "./plugins/bundled-ids.js";

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

type ChannelPresenceOptions = {
  includePersistedAuthState?: boolean;
  persistedAuthStateProbe?: {
    listChannelIds: () => readonly string[];
    hasState: (params: {
      channelId: string;
      cfg: OpenClawConfig;
      env: NodeJS.ProcessEnv;
    }) => boolean;
  };
};

export function hasMeaningfulChannelConfig(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => key !== "enabled");
}

function listChannelEnvPrefixes(
  channelIds: readonly string[],
): Array<[prefix: string, channelId: string]> {
  return channelIds.map((channelId) => [
    `${channelId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`,
    channelId,
  ]);
}

function hasPersistedChannelState(env: NodeJS.ProcessEnv): boolean {
  return fs.existsSync(resolveStateDir(env, os.homedir));
}

let persistedAuthStateChannelIds: readonly string[] | null = null;

function listPersistedAuthStateChannelIds(options: ChannelPresenceOptions): readonly string[] {
  const override = options.persistedAuthStateProbe?.listChannelIds();
  if (override) {
    return override;
  }
  if (persistedAuthStateChannelIds) {
    return persistedAuthStateChannelIds;
  }
  persistedAuthStateChannelIds = listBundledChannelIdsWithPersistedAuthState();
  return persistedAuthStateChannelIds;
}

function hasPersistedAuthState(params: {
  channelId: string;
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  options: ChannelPresenceOptions;
}): boolean {
  const override = params.options.persistedAuthStateProbe;
  if (override) {
    return override.hasState(params);
  }
  return hasBundledChannelPersistedAuthState(params);
}

export function listPotentialConfiguredChannelIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: ChannelPresenceOptions = {},
): string[] {
  const configuredChannelIds = new Set<string>();
  const channelIds = listBundledChannelPluginIds();
  const channelEnvPrefixes = listChannelEnvPrefixes(channelIds);
  const channels = isRecord(cfg.channels) ? cfg.channels : null;
  if (channels) {
    for (const [key, value] of Object.entries(channels)) {
      if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) {
        continue;
      }
      if (hasMeaningfulChannelConfig(value)) {
        configuredChannelIds.add(key);
      }
    }
  }

  for (const [key, value] of Object.entries(env)) {
    if (!hasNonEmptyString(value)) {
      continue;
    }
    for (const [prefix, channelId] of channelEnvPrefixes) {
      if (key.startsWith(prefix)) {
        configuredChannelIds.add(channelId);
      }
    }
  }

  if (options.includePersistedAuthState !== false && hasPersistedChannelState(env)) {
    for (const channelId of listPersistedAuthStateChannelIds(options)) {
      if (hasPersistedAuthState({ channelId, cfg, env, options })) {
        configuredChannelIds.add(channelId);
      }
    }
  }

  return [...configuredChannelIds];
}

function hasEnvConfiguredChannel(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
  options: ChannelPresenceOptions = {},
): boolean {
  const channelIds = listBundledChannelPluginIds();
  const channelEnvPrefixes = listChannelEnvPrefixes(channelIds);
  for (const [key, value] of Object.entries(env)) {
    if (!hasNonEmptyString(value)) {
      continue;
    }
    if (channelEnvPrefixes.some(([prefix]) => key.startsWith(prefix))) {
      return true;
    }
  }
  if (options.includePersistedAuthState === false || !hasPersistedChannelState(env)) {
    return false;
  }
  return listPersistedAuthStateChannelIds(options).some((channelId) =>
    hasPersistedAuthState({ channelId, cfg, env, options }),
  );
}

export function hasPotentialConfiguredChannels(
  cfg: OpenClawConfig | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
  options: ChannelPresenceOptions = {},
): boolean {
  const channels = isRecord(cfg?.channels) ? cfg.channels : null;
  if (channels) {
    for (const [key, value] of Object.entries(channels)) {
      if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) {
        continue;
      }
      if (hasMeaningfulChannelConfig(value)) {
        return true;
      }
    }
  }
  return hasEnvConfiguredChannel(cfg ?? {}, env, options);
}

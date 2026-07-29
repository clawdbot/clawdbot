/**
 * Channel configuration presence detection.
 *
 * Finds channels made available by config, env, persisted auth, or plugin discovery signals.
 */
import fs from "node:fs";
import os from "node:os";
import { normalizeOptionalLowercaseString } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  hasBundledChannelPersistedAuthState,
  listBundledChannelIdsWithPersistedAuthState,
} from "../channels/plugins/persisted-auth-state.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { hasNonEmptyString } from "../infra/outbound/channel-target.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { listOfficialExternalChannelEnvVars } from "../plugins/official-external-plugin-catalog.js";
import { isRecord } from "../utils.js";
import { listBundledChannelIds } from "./plugins/bundled-ids.js";

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);

export type AmbientEnvTriggerPolicy = "allow" | "suppress";

type ChannelPresenceOptions = {
  channelIds?: readonly string[];
  discovery?: PluginDiscoveryResult;
  includePersistedAuthState?: boolean;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
  persistedAuthStateProbe?: {
    listChannelIds: () => readonly string[];
    hasState: (params: {
      channelId: string;
      cfg: OpenClawConfig;
      env: NodeJS.ProcessEnv;
    }) => boolean;
  };
};

/** Source that made a channel look potentially configured. */
export type ChannelPresenceSignalSource = "config" | "env" | "persisted-auth";

type ChannelPresenceSignal = {
  channelId: string;
  source: ChannelPresenceSignalSource;
};

/** Returns true when a channel config entry contains settings beyond enabled/disabled state. */
export function hasMeaningfulChannelConfig(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  // `enabled` alone is operator intent, not configuration material; setup/status code uses this
  // distinction to avoid treating explicit disables as configured channels.
  return Object.keys(value).some((key) => key !== "enabled");
}

/** Lists channels explicitly disabled in config so activation logic can suppress auto-detection. */
export function listExplicitlyDisabledChannelIdsForConfig(cfg: OpenClawConfig): string[] {
  const channels = isRecord(cfg.channels) ? cfg.channels : null;
  if (!channels) {
    return [];
  }
  return Object.entries(channels)
    .filter(([, value]) => isRecord(value) && value.enabled === false)
    .map(([channelId]) => normalizeOptionalLowercaseString(channelId))
    .filter((channelId): channelId is string => Boolean(channelId));
}

function listChannelEnvPrefixes(
  channelIds: readonly string[],
): Array<[prefix: string, channelId: string]> {
  // Match channel-owned env namespaces such as MATRIX_* without hardcoding bundled ids here.
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
  if (options.discovery) {
    return listBundledChannelIdsWithPersistedAuthState(options.discovery);
  }
  if (persistedAuthStateChannelIds) {
    return persistedAuthStateChannelIds;
  }
  // Bundled plugin metadata is process-stable; cache the static persisted-auth id list.
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
  return hasBundledChannelPersistedAuthState({
    channelId: params.channelId,
    cfg: params.cfg,
    env: params.env,
    discovery: params.options.discovery,
  });
}

/** Lists channel ids detected from config, env vars, or persisted auth state. */
export function listPotentialConfiguredChannelIds(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: ChannelPresenceOptions = {},
): string[] {
  return uniqueStrings(
    listPotentialConfiguredChannelPresenceSignals(cfg, env, options).map(
      (signal) => signal.channelId,
    ),
  );
}

/** Lists deduplicated channel presence signals with their detection source. */
export function listPotentialConfiguredChannelPresenceSignals(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  options: ChannelPresenceOptions = {},
): ChannelPresenceSignal[] {
  const signals: ChannelPresenceSignal[] = [];
  const seenSignals = new Set<string>();
  const addSignal = (channelId: string, source: ChannelPresenceSignalSource) => {
    const key = `${source}:${channelId}`;
    if (seenSignals.has(key)) {
      return;
    }
    seenSignals.add(key);
    signals.push({ channelId, source });
  };
  const configuredChannelIds = new Set<string>();
  const channelIds = options.channelIds ?? listBundledChannelIds(env, options.discovery);
  const channelEnvPrefixes = listChannelEnvPrefixes(channelIds);
  const scopedChannelIds = options.channelIds
    ? new Set(
        options.channelIds
          .map((channelId) => normalizeOptionalLowercaseString(channelId))
          .filter((channelId): channelId is string => Boolean(channelId)),
      )
    : undefined;
  const officialExternalChannelEnvVars = listOfficialExternalChannelEnvVars().filter(
    ({ channelId }) => !scopedChannelIds || scopedChannelIds.has(channelId),
  );
  const channels = isRecord(cfg.channels) ? cfg.channels : null;
  if (channels) {
    for (const [key, value] of Object.entries(channels)) {
      if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) {
        continue;
      }
      // Shared channel defaults are not concrete channel configuration; only per-channel entries
      // with meaningful settings should produce presence signals.
      if (hasMeaningfulChannelConfig(value)) {
        configuredChannelIds.add(key);
        addSignal(key, "config");
      }
    }
  }

  if (options.ambientEnvTriggers !== "suppress") {
    for (const [key, value] of Object.entries(env)) {
      if (!hasNonEmptyString(value)) {
        continue;
      }
      for (const [prefix, channelId] of channelEnvPrefixes) {
        if (key.startsWith(prefix)) {
          configuredChannelIds.add(channelId);
          addSignal(channelId, "env");
        }
      }
      for (const { channelId, envVars } of officialExternalChannelEnvVars) {
        if (envVars.includes(key)) {
          configuredChannelIds.add(channelId);
          addSignal(channelId, "env");
        }
      }
    }
  }

  if (options.includePersistedAuthState !== false && hasPersistedChannelState(env)) {
    // Persisted auth can make a channel usable even when config/env is empty, but only probe it
    // when the state directory exists to keep startup/status checks cheap.
    for (const channelId of listPersistedAuthStateChannelIds(options)) {
      if (hasPersistedAuthState({ channelId, cfg, env, options })) {
        configuredChannelIds.add(channelId);
        addSignal(channelId, "persisted-auth");
      }
    }
  }

  return signals.filter((signal) => configuredChannelIds.has(signal.channelId));
}

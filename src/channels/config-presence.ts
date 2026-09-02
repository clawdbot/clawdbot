/**
 * Channel configuration presence detection.
 *
 * Finds channels made available by config, env, persisted auth, or plugin discovery signals.
 */
import fs from "node:fs";
import os from "node:os";
import {
  hasNonEmptyString,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  hasBundledChannelPersistedAuthState,
  listBundledChannelIdsWithPersistedAuthState,
} from "../channels/plugins/persisted-auth-state.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginDiscoveryResult } from "../plugins/discovery.js";
import { listOfficialExternalChannelEnvVars } from "../plugins/official-external-plugin-catalog.js";
import { isRecord } from "../utils.js";
import { isChannelConfigMetadataKey } from "./config-metadata.js";
import { listBundledChannelIds } from "./plugins/bundled-ids.js";

export type AmbientEnvTriggerPolicy = "allow" | "suppress";

type ChannelPresenceOptions = {
  channelIds?: readonly string[];
  discovery?: PluginDiscoveryResult;
  includePersistedAuthState?: boolean;
  ambientEnvTriggers?: AmbientEnvTriggerPolicy;
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
    .map(([channelId]) => channelId.trim())
    .filter((channelId) => channelId && !isChannelConfigMetadataKey(channelId))
    .map((channelId) => normalizeOptionalLowercaseString(channelId))
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
  const addSignal = (rawChannelId: string, source: ChannelPresenceSignalSource) => {
    const channelId = rawChannelId.trim();
    if (!channelId || isChannelConfigMetadataKey(channelId)) {
      return;
    }
    const key = `${source}:${channelId}`;
    if (seenSignals.has(key)) {
      return;
    }
    seenSignals.add(key);
    signals.push({ channelId, source });
  };
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
      if (isChannelConfigMetadataKey(key)) {
        continue;
      }
      // Shared channel defaults are not concrete channel configuration; only per-channel entries
      // with meaningful settings should produce presence signals.
      if (hasMeaningfulChannelConfig(value)) {
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
          addSignal(channelId, "env");
        }
      }
      for (const { channelId, envVars } of officialExternalChannelEnvVars) {
        if (envVars.includes(key)) {
          addSignal(channelId, "env");
        }
      }
    }
  }

  if (options.includePersistedAuthState !== false && hasPersistedChannelState(env)) {
    // Persisted auth can make a channel usable even when config/env is empty, but only probe it
    // when the state directory exists to keep startup/status checks cheap.
    for (const channelId of listBundledChannelIdsWithPersistedAuthState(options.discovery)) {
      if (
        hasBundledChannelPersistedAuthState({
          channelId,
          cfg,
          env,
          discovery: options.discovery,
        })
      ) {
        addSignal(channelId, "persisted-auth");
      }
    }
  }

  return signals;
}

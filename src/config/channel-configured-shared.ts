// Shares channel-configured checks across config and runtime surfaces.
import { normalizeChatChannelId } from "../channels/ids.js";
import { getChannelEnvVars } from "../secrets/channel-env-vars.js";
import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./types.openclaw.js";

/** Returns a channel config object when `channels.<id>` is present and object-shaped. */
export function resolveChannelConfigRecord(
  cfg: OpenClawConfig,
  channelId: string,
): Record<string, unknown> | null {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  if (!channels) {
    return null;
  }
  const entry = channels[channelId];
  if (isRecord(entry)) {
    return entry;
  }
  // Validation admits any declared spelling of a channel against canonical identity — the
  // config record resolves the AUTHORED key through the same identity, or an authored variant
  // (`channels.QQBot`) validates while activation misses the canonical lookup, skips incumbent
  // suppression, and first registration serves an implementation whose schema never accepted
  // the settings.
  const canonical = normalizeChatChannelId(channelId) ?? channelId;
  const authoredKey = Object.keys(channels).find(
    (key) => (normalizeChatChannelId(key) ?? key) === canonical,
  );
  const authored = authoredKey === undefined ? undefined : channels[authoredKey];
  return isRecord(authored) ? authored : null;
}

/** Checks whether a shallow channel config contains activation-relevant values. */
export function hasMeaningfulChannelConfigShallow(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 1 && keys[0] === "enabled") {
    // `enabled: false` alone is an explicit non-configuration signal, but true opts in.
    return value.enabled === true;
  }
  return keys.some((key) => key !== "enabled");
}

/** Detects static channel configuration from known env vars or `channels.<id>` config. */
export function isStaticallyChannelConfigured(
  cfg: OpenClawConfig,
  channelId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  for (const envVar of getChannelEnvVars(channelId, { config: cfg, env })) {
    if (typeof env[envVar] === "string" && env[envVar].trim().length > 0) {
      return true;
    }
  }
  return hasMeaningfulChannelConfigShallow(resolveChannelConfigRecord(cfg, channelId));
}

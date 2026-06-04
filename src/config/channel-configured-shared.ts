// Shares channel-configured checks across config and runtime surfaces.
import { getChannelEnvVars } from "../secrets/channel-env-vars.js";
import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./config.js";

/** Returns a channel config object when `channels.<id>` is present and object-shaped. */
export function resolveChannelConfigRecord(
  cfg: OpenClawConfig,
  channelId: string,
): Record<string, unknown> | null {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  return isRecord(entry) ? entry : null;
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

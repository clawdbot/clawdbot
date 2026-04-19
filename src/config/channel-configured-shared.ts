import { getChannelEnvVars } from "../secrets/channel-env-vars.js";
import { isRecord } from "../utils.js";
import type { OpenClawConfig } from "./config.js";

export function resolveChannelConfigRecord(
  cfg: OpenClawConfig,
  channelId: string,
): Record<string, unknown> | null {
  const channels = cfg.channels as Record<string, unknown> | undefined;
  const entry = channels?.[channelId];
  return isRecord(entry) ? entry : null;
}

export function hasMeaningfulChannelConfigShallow(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => key !== "enabled");
}

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

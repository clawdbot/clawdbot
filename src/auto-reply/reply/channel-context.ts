import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { getActivePluginChannelRegistry } from "../../plugins/runtime.js";
import {
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "../../shared/string-coerce.js";

type CommandSurfaceParams = {
  ctx: {
    OriginatingChannel?: string;
    Surface?: string;
    Provider?: string;
    AccountId?: string;
  };
  command: {
    channel?: string;
  };
};

type ChannelAccountParams = {
  cfg: OpenClawConfig;
  ctx: {
    OriginatingChannel?: string;
    Surface?: string;
    Provider?: string;
    AccountId?: string;
  };
  command: {
    channel?: string;
  };
};

export function resolveCommandSurfaceChannel(params: CommandSurfaceParams): string {
  const channel =
    params.ctx.OriginatingChannel ??
    params.command.channel ??
    params.ctx.Surface ??
    params.ctx.Provider;
  return normalizeOptionalLowercaseString(channel) ?? "";
}

export function resolveChannelAccountId(params: ChannelAccountParams): string {
  const accountId = normalizeOptionalString(params.ctx.AccountId) ?? "";
  if (accountId) {
    return accountId;
  }
  const channel = resolveCommandSurfaceChannel(params);
  const plugin = getActivePluginChannelRegistry()?.channels.find(
    (entry) => entry.plugin.id === channel,
  )?.plugin;
  const configuredDefault = normalizeOptionalString(plugin?.config.defaultAccountId?.(params.cfg));
  return configuredDefault || "default";
}

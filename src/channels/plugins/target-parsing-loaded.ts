import {
  channelRouteTargetsMatchExact,
  channelRouteTargetsShareConversation,
  resolveChannelRouteTargetWithParser,
  type ChannelRouteExplicitTarget,
  type ChannelRouteParsedTarget,
} from "../../plugin-sdk/channel-route.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { getLoadedChannelPluginForRead } from "./registry-loaded-read.js";

export type { ChannelRouteParsedTarget } from "../../plugin-sdk/channel-route.js";

export type ParsedChannelExplicitTarget = ChannelRouteExplicitTarget;

/** @deprecated Use `ChannelRouteParsedTarget`. */
export type ComparableChannelTarget = ChannelRouteParsedTarget;

export function parseExplicitTargetForLoadedChannel(
  channel: string,
  rawTarget: string,
): ParsedChannelExplicitTarget | null {
  const resolvedChannel = normalizeOptionalString(channel);
  if (!resolvedChannel) {
    return null;
  }
  return (
    getLoadedChannelPluginForRead(resolvedChannel)?.messaging?.parseExplicitTarget?.({
      raw: rawTarget,
    }) ?? null
  );
}

export function resolveRouteTargetForLoadedChannel(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null {
  return resolveChannelRouteTargetWithParser({
    ...params,
    parseExplicitTarget: parseExplicitTargetForLoadedChannel,
  });
}

/** @deprecated Use `resolveRouteTargetForLoadedChannel`. */
export function resolveComparableTargetForLoadedChannel(params: {
  channel: string;
  rawTarget?: string | null;
  fallbackThreadId?: string | number | null;
}): ChannelRouteParsedTarget | null {
  return resolveRouteTargetForLoadedChannel(params);
}

/** @deprecated Use `channelRouteTargetsMatchExact` from `openclaw/plugin-sdk/channel-route`. */
export function comparableChannelTargetsMatch(params: {
  left?: ChannelRouteParsedTarget | null;
  right?: ChannelRouteParsedTarget | null;
}): boolean {
  return channelRouteTargetsMatchExact(params);
}

/** @deprecated Use `channelRouteTargetsShareConversation` from `openclaw/plugin-sdk/channel-route`. */
export function comparableChannelTargetsShareRoute(params: {
  left?: ChannelRouteParsedTarget | null;
  right?: ChannelRouteParsedTarget | null;
}): boolean {
  return channelRouteTargetsShareConversation(params);
}

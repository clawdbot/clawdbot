// Discord plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  resolveChannelStreamingBlockEnabled,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

type StreamingEntry = Parameters<typeof resolveChannelStreamingBlockEnabled>[0];

function hasExplicitPreviewMode(account: { streaming?: unknown } | null | undefined): boolean {
  const streaming = account?.streaming;
  return Boolean(
    streaming &&
    typeof streaming === "object" &&
    !Array.isArray(streaming) &&
    Object.hasOwn(streaming, "mode"),
  );
}

export function resolveDiscordPreviewStreamMode(
  params: {
    streaming?: unknown;
  } = {},
): StreamingMode {
  if (params.streaming === undefined) {
    return "progress";
  }
  return resolveChannelPreviewStreamMode(params, "off");
}

export function resolveDiscordBlockStreamingEnabled(params: {
  account?: StreamingEntry | null;
  previewAvailable: boolean;
  streamMode?: StreamingMode;
  legacyBlockStreamingDefault?: "off" | "on";
}): boolean {
  const explicitBlock = resolveChannelStreamingBlockEnabled(params.account);
  if (typeof explicitBlock === "boolean") {
    return explicitBlock;
  }
  const streamMode = params.streamMode ?? resolveDiscordPreviewStreamMode(params.account ?? {});
  return (
    !(params.previewAvailable && hasExplicitPreviewMode(params.account) && streamMode !== "off") &&
    params.legacyBlockStreamingDefault === "on"
  );
}

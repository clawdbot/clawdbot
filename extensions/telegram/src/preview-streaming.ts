// Telegram plugin module implements preview streaming behavior.
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

export function resolveTelegramPreviewStreamMode(
  params: {
    streaming?: unknown;
  } = {},
): StreamingMode {
  // Telegram defaults to the progress draft like Discord: on tool-heavy turns a
  // status draft answers "is it working?", which streamed answer text cannot.
  // Operators who prefer streamed answer text set `streaming.mode: "partial"`.
  return resolveChannelPreviewStreamMode(params, "progress");
}

export function resolveTelegramBlockStreamingEnabled(params: {
  account?: StreamingEntry | null;
  previewAvailable: boolean;
  streamMode?: StreamingMode;
  legacyBlockStreamingDefault?: "off" | "on";
}): boolean {
  const explicitBlock = resolveChannelStreamingBlockEnabled(params.account);
  if (typeof explicitBlock === "boolean") {
    return explicitBlock;
  }
  const streamMode = params.streamMode ?? resolveTelegramPreviewStreamMode(params.account ?? {});
  return (
    !(params.previewAvailable && hasExplicitPreviewMode(params.account) && streamMode !== "off") &&
    params.legacyBlockStreamingDefault === "on"
  );
}

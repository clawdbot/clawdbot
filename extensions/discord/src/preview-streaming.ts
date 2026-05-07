import {
  resolveChannelPreviewStreamMode,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-streaming";

type DiscordPreviewStreamMode = StreamingMode;

export function resolveDiscordPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): DiscordPreviewStreamMode {
  if (params.streaming === undefined && params.streamMode === undefined) {
    return "progress";
  }
  return resolveChannelPreviewStreamMode(params, "off");
}

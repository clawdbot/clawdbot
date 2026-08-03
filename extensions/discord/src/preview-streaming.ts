// Discord plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

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

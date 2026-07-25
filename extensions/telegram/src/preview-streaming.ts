// Telegram plugin module implements preview streaming behavior.
import {
  resolveChannelPreviewStreamMode,
  type StreamingMode,
} from "openclaw/plugin-sdk/channel-outbound";

export function resolveTelegramPreviewStreamMode(
  params: {
    streaming?: unknown;
  } = {},
): StreamingMode {
  return resolveChannelPreviewStreamMode(params, "partial");
}

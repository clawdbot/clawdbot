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
  // Telegram defaults to the progress draft: on tool-heavy turns a status draft
  // answers "is it working?", which streamed answer text cannot.
  // Operators who prefer streamed answer text set `streaming.mode: "partial"`.
  return resolveChannelPreviewStreamMode(params, "progress");
}

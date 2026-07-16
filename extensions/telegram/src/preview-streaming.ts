import { resolveChannelPreviewStreamMode } from "openclaw/plugin-sdk/channel-streaming";

export type TelegramPreviewStreamMode = "off" | "partial" | "block";

export function resolveTelegramPreviewStreamMode(
  params: {
    streamMode?: unknown;
    streaming?: unknown;
  } = {},
): TelegramPreviewStreamMode {
  return resolveChannelPreviewStreamMode(params, "partial");
}

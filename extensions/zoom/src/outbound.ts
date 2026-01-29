import type { ChannelOutboundAdapter } from "clawdbot/plugin-sdk";

import { getZoomRuntime } from "./runtime.js";
import { sendZoomTextMessage } from "./send.js";

export const zoomOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  chunker: (text, limit) => getZoomRuntime().channel.text.chunkMarkdownText(text, limit),
  chunkerMode: "markdown",
  textChunkLimit: 4000,

  sendText: async ({ cfg, to, text, deps }) => {
    const send =
      deps?.sendZoom ??
      ((to: string, text: string) => sendZoomTextMessage({ cfg, to, text }));
    const result = await send(to, text);
    return { channel: "zoom", ...result };
  },

  sendMedia: async ({ cfg, to, text, mediaUrl }) => {
    // Zoom Team Chat has limited inline media support
    // Send media URL as a link in the message
    const mediaText = mediaUrl ? `${text ? `${text}\n\n` : ""}${mediaUrl}` : text;
    const result = await sendZoomTextMessage({ cfg, to, text: mediaText });
    return { channel: "zoom", ...result };
  },
};

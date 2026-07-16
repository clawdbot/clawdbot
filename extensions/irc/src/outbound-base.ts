import { sanitizeForPlainText } from "openclaw/plugin-sdk/outbound-runtime";
import { chunkTextForOutbound } from "./channel-api.js";

export const ircOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown" as const,
  textChunkLimit: 350,
  sanitizeText: ({ text }: { text: string }) => sanitizeForPlainText(text),
};

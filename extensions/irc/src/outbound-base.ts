// Irc plugin module implements outbound base behavior.
import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { chunkTextForOutbound } from "./channel-api.js";

export const ircOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown" as const,
  textChunkLimit: 350,
  sanitizeText: ({ text }: { text: string }) => sanitizeForPlainText(text),
};

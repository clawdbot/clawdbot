// Whatsapp plugin module owns durable inbound payload serialization.
import type { WAMessage } from "baileys";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import { BufferJSON } from "../session.runtime.js";

export type SerializedWhatsAppDurableInboundMessage = PluginJsonValue;

export class WhatsAppIngressPermanentError extends Error {
  constructor(
    readonly reason: "invalid-payload" | "missing-message-key" | "event-id-mismatch",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "WhatsAppIngressPermanentError";
  }
}

export function serializeWhatsAppDurableInboundMessage(
  message: WAMessage,
): SerializedWhatsAppDurableInboundMessage {
  const timestamp = message.messageTimestamp;
  let serializedMessage = message;
  if (timestamp != null && typeof timestamp === "object") {
    try {
      const numericTimestamp = Number(timestamp);
      if (Number.isFinite(numericTimestamp)) {
        // Protobuf Long methods do not survive JSON. Persist the exact seconds
        // value so append-age admission sees the same timestamp after replay.
        serializedMessage = { ...message, messageTimestamp: numericTimestamp };
      }
    } catch {
      // Leave malformed timestamp handling to the normal inbound admission path.
    }
  }
  return JSON.parse(JSON.stringify(serializedMessage, BufferJSON.replacer)) as PluginJsonValue;
}

export function deserializeWhatsAppDurableInboundMessage(
  message: SerializedWhatsAppDurableInboundMessage,
): WAMessage {
  try {
    return JSON.parse(JSON.stringify(message), BufferJSON.reviver) as WAMessage;
  } catch (error) {
    throw new WhatsAppIngressPermanentError(
      "invalid-payload",
      "WhatsApp ingress row contains an invalid serialized message",
      { cause: error },
    );
  }
}

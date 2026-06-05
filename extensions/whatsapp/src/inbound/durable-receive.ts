// Whatsapp plugin module implements durable receive behavior.
import { createHash } from "node:crypto";
import type { WAMessage } from "baileys";
import { createDurableInboundReceiveJournalFromQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import { getWhatsAppRuntime } from "../runtime.js";
import { BufferJSON } from "../session.runtime.js";

const WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES = 450;
const WHATSAPP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES = 450;
const WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const WHATSAPP_DURABLE_INBOUND_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type WhatsAppReadReceiptTarget = {
  remoteJid: string;
  id: string;
  participant?: string;
};

export type SerializedWhatsAppDurableInboundMessage = PluginJsonValue;

export type WhatsAppDurableInboundPayload = {
  message: SerializedWhatsAppDurableInboundMessage;
  upsertType?: string;
  receivedAt: number;
};

export type WhatsAppDurableInboundMetadata = {
  readReceipt?: WhatsAppReadReceiptTarget;
};

export type WhatsAppDurableInboundCompletedMetadata = {
  readReceipt?: WhatsAppReadReceiptTarget;
};

function hashNamespacePart(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

export function createWhatsAppDurableInboundMessageId(params: {
  remoteJid: string;
  id: string;
}): string {
  return createHash("sha256").update(`${params.remoteJid}\n${params.id}`).digest("hex");
}

export function serializeWhatsAppDurableInboundMessage(
  message: WAMessage,
): SerializedWhatsAppDurableInboundMessage {
  return JSON.parse(JSON.stringify(message, BufferJSON.replacer)) as PluginJsonValue;
}

export function deserializeWhatsAppDurableInboundMessage(
  message: SerializedWhatsAppDurableInboundMessage,
): WAMessage {
  return JSON.parse(JSON.stringify(message), BufferJSON.reviver) as WAMessage;
}

export function createWhatsAppDurableInboundReceiveJournal(accountId: string) {
  const accountPart = hashNamespacePart(accountId);
  const runtime = getWhatsAppRuntime();
  const queue = runtime.state.openChannelIngressQueue<
    WhatsAppDurableInboundPayload,
    WhatsAppDurableInboundMetadata,
    WhatsAppDurableInboundCompletedMetadata
  >({
    accountId: accountPart,
    stateDir: runtime.state.resolveStateDir(),
  });
  return createDurableInboundReceiveJournalFromQueue({
    queue,
    retention: {
      pendingTtlMs: WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS,
      completedTtlMs: WHATSAPP_DURABLE_INBOUND_COMPLETED_TTL_MS,
      failedTtlMs: WHATSAPP_DURABLE_INBOUND_PENDING_TTL_MS,
      pendingMaxEntries: WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
      completedMaxEntries: WHATSAPP_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES,
      failedMaxEntries: WHATSAPP_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
    },
  });
}

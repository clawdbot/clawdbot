import { resolveInboundDebounceMs } from "openclaw/plugin-sdk/channel-inbound-debounce";
import { normalizeWebInboundMessage } from "../../inbound/message-aliases.js";
import type { WebInboundMessageInput } from "../../inbound/types.js";
import { getRuntimeConfig } from "../config.runtime.js";

type WhatsAppConversationDebounceEntry = {
  debounceMs?: number;
};

function normalizeDebounceMs(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.trunc(value)
    : undefined;
}

function resolveWhatsAppScopedDebounceMs(params: {
  entries?: Record<string, WhatsAppConversationDebounceEntry | undefined>;
  id?: string | null;
}): number | undefined {
  const specific = params.id
    ? normalizeDebounceMs(params.entries?.[params.id]?.debounceMs)
    : undefined;
  if (specific !== undefined) {
    return specific;
  }
  return normalizeDebounceMs(params.entries?.["*"]?.debounceMs);
}

export function resolveWhatsAppConversationDebounceMs(params: {
  cfg: ReturnType<typeof getRuntimeConfig>;
  msg: WebInboundMessageInput;
}): number {
  const defaultMs = resolveInboundDebounceMs({
    cfg: params.cfg,
    channel: "whatsapp",
  });
  const normalized = normalizeWebInboundMessage(params.msg);
  const admission = normalized.admission;
  if (!admission || admission.ingress.decision !== "allow") {
    return defaultMs;
  }
  const channel = params.cfg.channels?.whatsapp;
  const scoped =
    admission.conversation.kind === "group"
      ? resolveWhatsAppScopedDebounceMs({
          entries: channel?.groups,
          id: admission.conversation.id,
        })
      : resolveWhatsAppScopedDebounceMs({
          entries: channel?.direct,
          id: admission.conversation.id,
        });
  return scoped ?? defaultMs;
}

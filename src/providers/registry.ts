import { normalizeMessageProvider } from "../utils/message-provider.js";

export const CHAT_PROVIDER_ORDER = [
  "telegram",
  "whatsapp",
  "discord",
  "slack",
  "signal",
  "imessage",
  "msteams",
] as const;

export type ChatProviderId = (typeof CHAT_PROVIDER_ORDER)[number];

export const DEFAULT_CHAT_PROVIDER: ChatProviderId = "whatsapp";

export type ChatProviderMeta = {
  id: ChatProviderId;
  label: string;
  selectionLabel: string;
  docsPath: string;
  docsLabel?: string;
  blurb: string;
};

const CHAT_PROVIDER_META: Record<ChatProviderId, ChatProviderMeta> = {
  telegram: {
    id: "telegram",
    label: "Telegram",
    selectionLabel: "Telegram (Bot API)",
    docsPath: "/telegram",
    docsLabel: "telegram",
    blurb:
      "simplest way to get started — register a bot with @BotFather and get going.",
  },
  whatsapp: {
    id: "whatsapp",
    label: "WhatsApp",
    selectionLabel: "WhatsApp (QR link)",
    docsPath: "/whatsapp",
    docsLabel: "whatsapp",
    blurb: "works with your own number; recommend a separate phone + eSIM.",
  },
  discord: {
    id: "discord",
    label: "Discord",
    selectionLabel: "Discord (Bot API)",
    docsPath: "/discord",
    docsLabel: "discord",
    blurb: "very well supported right now.",
  },
  slack: {
    id: "slack",
    label: "Slack",
    selectionLabel: "Slack (Socket Mode)",
    docsPath: "/slack",
    docsLabel: "slack",
    blurb: "supported (Socket Mode).",
  },
  signal: {
    id: "signal",
    label: "Signal",
    selectionLabel: "Signal (signal-cli)",
    docsPath: "/signal",
    docsLabel: "signal",
    blurb:
      'signal-cli linked device; more setup (David Reagans: "Hop on Discord.").',
  },
  imessage: {
    id: "imessage",
    label: "iMessage",
    selectionLabel: "iMessage (imsg)",
    docsPath: "/imessage",
    docsLabel: "imessage",
    blurb: "this is still a work in progress.",
  },
  msteams: {
    id: "msteams",
    label: "MS Teams",
    selectionLabel: "Microsoft Teams (Bot Framework)",
    docsPath: "/msteams",
    docsLabel: "msteams",
    blurb: "supported (Bot Framework).",
  },
};

const WEBSITE_URL = "https://clawd.bot";

export function listChatProviders(): ChatProviderMeta[] {
  return CHAT_PROVIDER_ORDER.map((id) => CHAT_PROVIDER_META[id]);
}

export function getChatProviderMeta(id: ChatProviderId): ChatProviderMeta {
  return CHAT_PROVIDER_META[id];
}

export function normalizeChatProviderId(
  raw?: string | null,
): ChatProviderId | null {
  const normalized = normalizeMessageProvider(raw);
  if (!normalized) return null;
  return CHAT_PROVIDER_ORDER.includes(normalized as ChatProviderId)
    ? (normalized as ChatProviderId)
    : null;
}

export function formatProviderPrimerLine(meta: ChatProviderMeta): string {
  return `${meta.label}: ${meta.blurb}`;
}

export function formatProviderSelectionLine(
  meta: ChatProviderMeta,
  docsLink: (path: string, label?: string) => string,
): string {
  if (meta.id === "telegram") {
    return `${meta.label} — ${meta.blurb} ${docsLink(
      meta.docsPath,
    )} ${WEBSITE_URL}`;
  }
  return `${meta.label} — ${meta.blurb} Docs: ${docsLink(
    meta.docsPath,
    meta.docsLabel ?? meta.id,
  )}`;
}

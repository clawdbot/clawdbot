import type {
  ChannelMessagingAdapter,
  ChannelOutboundAdapter,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";

function parseTelegramTargetForTest(raw: string): {
  chatId: string;
  messageThreadId?: number;
  chatType: "direct" | "group" | "unknown";
} {
  const trimmed = raw.trim();
  const withoutPrefix = trimmed.replace(/^telegram:/i, "").trim();
  const topicMatch = withoutPrefix.match(/^(.*):topic:(\d+)$/i);
  const chatId = topicMatch?.[1]?.trim() || withoutPrefix;
  const messageThreadId = topicMatch?.[2] ? Number.parseInt(topicMatch[2], 10) : undefined;
  const numericId = chatId.startsWith("-") ? chatId.slice(1) : chatId;
  const chatType =
    /^\d+$/.test(numericId) && !chatId.startsWith("-100")
      ? "direct"
      : chatId.startsWith("-")
        ? "group"
        : "unknown";
  return { chatId, messageThreadId, chatType };
}

function normalizeWhatsAppTargetForTest(raw: string): string | null {
  const trimmed = raw
    .trim()
    .replace(/^whatsapp:/i, "")
    .trim();
  if (!trimmed) {
    return null;
  }
  const lowered = normalizeLowercaseStringOrEmpty(trimmed);
  if (lowered.endsWith("@g.us")) {
    const normalized = lowered.replace(/\s+/gu, "");
    return /^\d+@g\.us$/u.test(normalized) ? normalized : null;
  }
  const digits = trimmed.replace(/\D/gu, "");
  const normalized = digits ? `+${digits}` : "";
  return /^\+\d{7,15}$/u.test(normalized) ? normalized : null;
}

function createWhatsAppResolveTarget(label = "WhatsApp"): ChannelOutboundAdapter["resolveTarget"] {
  return ({ to }) => {
    const normalized = to ? normalizeWhatsAppTargetForTest(to) : null;
    if (!normalized) {
      return { ok: false, error: new Error(`${label} target is required`) };
    }
    return { ok: true, to: normalized };
  };
}

function createTelegramResolveTarget(label = "Telegram"): ChannelOutboundAdapter["resolveTarget"] {
  return ({ to }) => {
    const trimmed = to?.trim();
    if (!trimmed) {
      return { ok: false, error: new Error(`${label} target is required`) };
    }
    return { ok: true, to: parseTelegramTargetForTest(trimmed).chatId };
  };
}

export const telegramMessagingForTest: ChannelMessagingAdapter = {
  parseExplicitTarget: ({ raw }) => {
    const target = parseTelegramTargetForTest(raw);
    return {
      to: target.chatId,
      threadId: target.messageThreadId,
      chatType: target.chatType === "unknown" ? undefined : target.chatType,
    };
  },
  inferTargetChatType: ({ to }) => {
    const target = parseTelegramTargetForTest(to);
    return target.chatType === "unknown" ? undefined : target.chatType;
  },
};

export const whatsappMessagingForTest: ChannelMessagingAdapter = {
  inferTargetChatType: ({ to }) => {
    const normalized = normalizeWhatsAppTargetForTest(to);
    if (!normalized) {
      return undefined;
    }
    return normalized.endsWith("@g.us") ? "group" : "direct";
  },
  targetResolver: {
    hint: "<E.164|group JID>",
  },
};

export function createTestChannelPlugin(params: {
  id: ChannelPlugin["id"];
  label?: string;
  outbound?: ChannelOutboundAdapter;
  messaging?: ChannelMessagingAdapter;
  resolveDefaultTo?: (params: { cfg: OpenClawConfig }) => string | undefined;
}): ChannelPlugin {
  return {
    id: params.id,
    meta: {
      id: params.id,
      label: params.label ?? String(params.id),
      selectionLabel: params.label ?? String(params.id),
      docsPath: `/channels/${params.id}`,
      blurb: "test stub.",
    },
    capabilities: { chatTypes: ["direct", "group"] },
    config: {
      listAccountIds: () => [],
      resolveAccount: () => ({}),
      ...(params.resolveDefaultTo
        ? {
            resolveDefaultTo: params.resolveDefaultTo,
          }
        : {}),
    },
    ...(params.outbound ? { outbound: params.outbound } : {}),
    ...(params.messaging ? { messaging: params.messaging } : {}),
  };
}

export function createTelegramTestPlugin(): ChannelPlugin {
  return createTestChannelPlugin({
    id: "telegram",
    label: "Telegram",
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "telegram", messageId: "telegram-msg" }),
      resolveTarget: createTelegramResolveTarget(),
    },
    messaging: telegramMessagingForTest,
    resolveDefaultTo: ({ cfg }) =>
      typeof cfg.channels?.telegram?.defaultTo === "string"
        ? cfg.channels.telegram.defaultTo
        : undefined,
  });
}

export function createWhatsAppTestPlugin(): ChannelPlugin {
  return createTestChannelPlugin({
    id: "whatsapp",
    label: "WhatsApp",
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: "whatsapp", messageId: "whatsapp-msg" }),
      resolveTarget: createWhatsAppResolveTarget(),
    },
    messaging: whatsappMessagingForTest,
    resolveDefaultTo: ({ cfg }) =>
      typeof cfg.channels?.whatsapp?.defaultTo === "string"
        ? cfg.channels.whatsapp.defaultTo
        : undefined,
  });
}

export function createNoopOutboundChannelPlugin(
  id: "discord" | "imessage" | "slack",
): ChannelPlugin {
  return createTestChannelPlugin({
    id,
    outbound: {
      deliveryMode: "direct",
      sendText: async () => ({ channel: id, messageId: `${id}-msg` }),
    },
  });
}

export function createTargetsTestRegistry(
  plugins: ChannelPlugin[] = [createWhatsAppTestPlugin(), createTelegramTestPlugin()],
) {
  return createTestRegistry(
    plugins.map((plugin) => ({
      pluginId: plugin.id,
      plugin,
      source: "test",
    })),
  );
}

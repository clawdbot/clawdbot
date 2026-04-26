import type { ChannelOutboundAdapter } from "openclaw/plugin-sdk/channel-contract";
import type { ChannelPlugin } from "openclaw/plugin-sdk/core";
import { resolveOutboundSendDep } from "openclaw/plugin-sdk/outbound-send-deps";
import { collectStatusIssuesFromLastError } from "openclaw/plugin-sdk/status-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

function normalizeIMessageTestHandle(raw: string): string {
  let trimmed = raw.trim();
  if (!trimmed) {
    return "";
  }

  while (trimmed) {
    const lowered = normalizeLowercaseStringOrEmpty(trimmed);
    if (lowered.startsWith("imessage:")) {
      trimmed = trimmed.slice("imessage:".length).trim();
      continue;
    }
    if (lowered.startsWith("sms:")) {
      trimmed = trimmed.slice("sms:".length).trim();
      continue;
    }
    if (lowered.startsWith("auto:")) {
      trimmed = trimmed.slice("auto:".length).trim();
      continue;
    }
    break;
  }

  if (!trimmed) {
    return "";
  }

  if (/^(chat_id:|chat_guid:|chat_identifier:)/i.test(trimmed)) {
    return trimmed.replace(/^(chat_id:|chat_guid:|chat_identifier:)/i, (match) =>
      normalizeLowercaseStringOrEmpty(match),
    );
  }
  if (trimmed.includes("@")) {
    return normalizeLowercaseStringOrEmpty(trimmed);
  }
  const digits = trimmed.replace(/[^\d+]/g, "");
  if (digits) {
    return digits.startsWith("+") ? `+${digits.slice(1)}` : `+${digits}`;
  }
  return trimmed.replace(/\s+/g, "");
}

const defaultIMessageOutbound: ChannelOutboundAdapter = {
  deliveryMode: "direct",
  sendText: async ({ to, text, accountId, replyToId, deps, cfg }) => {
    const sendIMessage = resolveOutboundSendDep<
      (
        target: string,
        content: string,
        opts?: Record<string, unknown>,
      ) => Promise<{ messageId: string }>
    >(deps, "imessage");
    const result = await sendIMessage?.(to, text, {
      config: cfg,
      accountId: accountId ?? undefined,
      replyToId: replyToId ?? undefined,
    });
    return { channel: "imessage", messageId: result?.messageId ?? "imessage-test-stub" };
  },
  sendMedia: async ({ to, text, mediaUrl, accountId, replyToId, deps, cfg, mediaLocalRoots }) => {
    const sendIMessage = resolveOutboundSendDep<
      (
        target: string,
        content: string,
        opts?: Record<string, unknown>,
      ) => Promise<{ messageId: string }>
    >(deps, "imessage");
    const result = await sendIMessage?.(to, text, {
      config: cfg,
      mediaUrl,
      accountId: accountId ?? undefined,
      replyToId: replyToId ?? undefined,
      mediaLocalRoots,
    });
    return { channel: "imessage", messageId: result?.messageId ?? "imessage-test-stub" };
  },
};

export const createIMessageTestPlugin = (params?: {
  outbound?: ChannelOutboundAdapter;
}): ChannelPlugin => ({
  id: "imessage",
  meta: {
    id: "imessage",
    label: "iMessage",
    selectionLabel: "iMessage (imsg)",
    docsPath: "/channels/imessage",
    blurb: "iMessage test stub.",
    aliases: ["imsg"],
  },
  capabilities: { chatTypes: ["direct", "group"], media: true },
  config: {
    listAccountIds: () => [],
    resolveAccount: () => ({}),
  },
  status: {
    collectStatusIssues: (accounts) => collectStatusIssuesFromLastError("imessage", accounts),
  },
  outbound: params?.outbound ?? defaultIMessageOutbound,
  messaging: {
    targetResolver: {
      looksLikeId: (raw) => {
        const trimmed = raw.trim();
        if (!trimmed) {
          return false;
        }
        if (/^(imessage:|sms:|auto:|chat_id:|chat_guid:|chat_identifier:)/i.test(trimmed)) {
          return true;
        }
        if (trimmed.includes("@")) {
          return true;
        }
        return /^\+?\d{3,}$/.test(trimmed);
      },
      hint: "<handle|chat_id:ID>",
    },
    normalizeTarget: (raw) => normalizeIMessageTestHandle(raw),
  },
});

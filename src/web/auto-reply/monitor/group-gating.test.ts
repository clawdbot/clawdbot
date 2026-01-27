import { describe, expect, it } from "vitest";

import { applyGroupGating } from "./group-gating.js";

const baseConfig = {
  channels: {
    whatsapp: {
      groupPolicy: "open",
      groups: { "*": { requireMention: true } },
    },
  },
  session: { store: "/tmp/moltbot-sessions.json" },
} as const;

describe("applyGroupGating", () => {
  it("treats reply-to-bot as implicit mention", () => {
    const groupHistories = new Map();
    const result = applyGroupGating({
      cfg: baseConfig as unknown as ReturnType<
        typeof import("../../../config/config.js").loadConfig
      >,
      msg: {
        id: "m1",
        from: "123@g.us",
        conversationId: "123@g.us",
        to: "+15550000",
        accountId: "default",
        body: "following up",
        timestamp: Date.now(),
        chatType: "group",
        chatId: "123@g.us",
        selfJid: "15551234567@s.whatsapp.net",
        selfE164: "+15551234567",
        replyToId: "m0",
        replyToBody: "bot said hi",
        replyToSender: "+15551234567",
        replyToSenderJid: "15551234567@s.whatsapp.net",
        replyToSenderE164: "+15551234567",
        sendComposing: async () => {},
        reply: async () => {},
        sendMedia: async () => {},
      },
      conversationId: "123@g.us",
      groupHistoryKey: "whatsapp:default:group:123@g.us",
      agentId: "main",
      sessionKey: "agent:main:whatsapp:group:123@g.us",
      baseMentionConfig: { mentionRegexes: [] },
      groupHistories,
      groupHistoryLimit: 10,
      groupMemberNames: new Map(),
      logVerbose: () => {},
      replyLogger: { debug: () => {} },
    });

    expect(result.shouldProcess).toBe(true);
  });
});

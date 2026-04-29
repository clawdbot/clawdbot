import fs from "node:fs/promises";
import path from "node:path";
import { saveSessionStore } from "openclaw/plugin-sdk/session-store-runtime";
import { withTempDir } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import {
  debugMention,
  isBotMentionedFromTargets,
  resolveMentionTargets,
  resolveOwnerList,
} from "./mentions.js";
import { getSessionSnapshot } from "./session-snapshot.js";
import type { WebInboundMsg } from "./types.js";
import { elide, isLikelyWhatsAppCryptoError } from "./util.js";

const makeMsg = (overrides: Partial<WebInboundMsg>): WebInboundMsg =>
  ({
    id: "m1",
    from: "120363401234567890@g.us",
    conversationId: "120363401234567890@g.us",
    to: "15551234567@s.whatsapp.net",
    accountId: "default",
    body: "",
    chatType: "group",
    chatId: "120363401234567890@g.us",
    sendComposing: async () => {},
    reply: async () => {},
    sendMedia: async () => {},
    ...overrides,
  }) as WebInboundMsg;

describe("isBotMentionedFromTargets", () => {
  const mentionCfg = { mentionRegexes: [/\bopenclaw\b/i] };

  function expectMentioned(
    msg: WebInboundMsg,
    cfg: { mentionRegexes: RegExp[]; allowFrom?: Array<string | number>; isSelfChat?: boolean },
    expected: boolean,
  ) {
    const targets = resolveMentionTargets(msg);
    expect(isBotMentionedFromTargets(msg, cfg, targets)).toBe(expected);
  }

  it("ignores regex matches when other mentions are present", () => {
    const msg = makeMsg({
      body: "@OpenClaw please help",
      mentionedJids: ["19998887777@s.whatsapp.net"],
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
    });
    expectMentioned(msg, mentionCfg, false);
  });

  it("matches explicit self mentions", () => {
    const msg = makeMsg({
      body: "hey",
      mentionedJids: ["15551234567@s.whatsapp.net"],
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
    });
    expectMentioned(msg, mentionCfg, true);
  });

  it("falls back to regex when no mentions are present", () => {
    const msg = makeMsg({
      body: "openclaw can you help?",
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
    });
    expectMentioned(msg, mentionCfg, true);
  });

  it("ignores JID mentions in a true 1:1 self-chat (not a group)", () => {
    const cfg = { mentionRegexes: [/\bopenclaw\b/i], allowFrom: ["+999"] };
    const msg = makeMsg({
      // Direct chat with self, not a group — the original "ignore mentions
      // in self-chat" suppression still applies here so that mentioning the
      // owner in their own DM does not falsely trigger the bot.
      from: "999@s.whatsapp.net",
      conversationId: "999@s.whatsapp.net",
      chatType: "direct",
      body: "@owner ping",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });
    expectMentioned(msg, cfg, false);

    const msgTextMention = makeMsg({
      from: "999@s.whatsapp.net",
      conversationId: "999@s.whatsapp.net",
      chatType: "direct",
      body: "openclaw ping",
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });
    expectMentioned(msgTextMention, cfg, true);
  });

  it("detects an explicit group @mention even when self is in allowFrom (#49317)", () => {
    // Operator config commonly puts their own E.164 in allowFrom so they can
    // run owner-only commands in groups; previously, that flipped the gate
    // to "self-chat mode" and silently dropped mention detection in groups,
    // including LID-style WhatsApp mentions that resolve to the bot's own
    // E.164. After the fix, group conversations honor the identity-overlap
    // check regardless of allowFrom.
    const cfg = { mentionRegexes: [/\bopenclaw\b/i], allowFrom: ["+15551234567"] };
    const msg = makeMsg({
      // Default `from` is the @g.us group JID from `makeMsg`.
      body: "@216372600647751 can you see this?",
      mentionedJids: ["216372600647751@lid"],
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
      selfLid: "216372600647751@lid",
    });
    expectMentioned(msg, cfg, true);
  });

  it("honors explicit self-chat overrides without recomputing from allowFrom", () => {
    const cfg = {
      mentionRegexes: [/\bopenclaw\b/i],
      allowFrom: ["+15551230000"],
      isSelfChat: true,
    };
    const msg = makeMsg({
      body: "@owner ping",
      mentionedJids: ["999@s.whatsapp.net"],
      selfE164: "+999",
      selfJid: "999@s.whatsapp.net",
    });
    expectMentioned(msg, cfg, false);
  });

  it("matches fallback number mentions when regexes do not match", () => {
    const msg = makeMsg({
      body: "please check +1 555 123 4567",
      selfE164: "+15551234567",
      selfJid: "15551234567@s.whatsapp.net",
    });
    expectMentioned(msg, { mentionRegexes: [] }, true);
  });
});

describe("resolveMentionTargets with @lid mapping", () => {
  it("uses @lid reverse mapping for mentions and self identity", async () => {
    await withTempDir("openclaw-lid-mapping-", async (authDir) => {
      await fs.writeFile(
        path.join(authDir, "lid-mapping-777_reverse.json"),
        JSON.stringify("+1777"),
      );

      const mentionTargets = resolveMentionTargets(
        makeMsg({
          body: "ping",
          mentionedJids: ["777@lid"],
          selfE164: "+15551234567",
          selfJid: "15551234567@s.whatsapp.net",
        }),
        authDir,
      );
      expect(mentionTargets.normalizedMentions).toEqual([
        expect.objectContaining({
          jid: null,
          lid: "777@lid",
          e164: "+1777",
        }),
      ]);

      const selfTargets = resolveMentionTargets(
        makeMsg({
          body: "ping",
          selfJid: "777@lid",
        }),
        authDir,
      );
      expect(selfTargets.self.e164).toBe("+1777");
      expect(selfTargets.self.lid).toBe("777@lid");
    });
  });
});

describe("getSessionSnapshot", () => {
  it("uses channel reset overrides when configured", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 18, 5, 0, 0));
    try {
      await withTempDir("openclaw-snapshot-", async (root) => {
        const storePath = path.join(root, "sessions.json");
        const sessionKey = "agent:main:whatsapp:dm:s1";

        await saveSessionStore(storePath, {
          [sessionKey]: {
            sessionId: "snapshot-session",
            updatedAt: new Date(2026, 0, 18, 3, 30, 0).getTime(),
            lastChannel: "whatsapp",
          },
        });

        const cfg = {
          session: {
            store: storePath,
            reset: { mode: "daily", atHour: 4, idleMinutes: 240 },
            resetByChannel: {
              whatsapp: { mode: "idle", idleMinutes: 360 },
            },
          },
        } as Parameters<typeof getSessionSnapshot>[0];

        const snapshot = getSessionSnapshot(cfg, "whatsapp:+15550001111", true, {
          sessionKey,
        });

        expect(snapshot.resetPolicy.mode).toBe("idle");
        expect(snapshot.resetPolicy.idleMinutes).toBe(360);
        expect(snapshot.fresh).toBe(true);
        expect(snapshot.dailyResetAt).toBeUndefined();
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("web auto-reply util", () => {
  describe("mentions diagnostics", () => {
    it("returns normalized debug fields and mention outcome", () => {
      const msg = makeMsg({
        from: "777@lid",
        body: "openclaw ping",
        selfE164: "+15551234567",
        selfJid: "15551234567@s.whatsapp.net",
      });
      const result = debugMention(msg, { mentionRegexes: [/\bopenclaw\b/i] });
      expect(result.wasMentioned).toBe(true);
      expect(result.details.bodyClean).toBe("openclaw ping");
      expect(result.details.normalizedMentionedJids).toBeNull();
    });

    it("resolves owner list from allowFrom or falls back to self", () => {
      expect(
        resolveOwnerList(
          {
            mentionRegexes: [],
            allowFrom: ["*", " +1 555 000 1111 "],
          },
          null,
        ),
      ).toEqual(["+15550001111"]);
      expect(resolveOwnerList({ mentionRegexes: [] }, "+1 555 000 2222")).toEqual(["+15550002222"]);
    });
  });

  describe("elide", () => {
    it("returns undefined for undefined input", () => {
      expect(elide(undefined)).toBe(undefined);
    });

    it("returns input when under limit", () => {
      expect(elide("hi", 10)).toBe("hi");
    });

    it("truncates and annotates when over limit", () => {
      expect(elide("abcdef", 3)).toBe("abc… (truncated 3 chars)");
    });
  });

  describe("isLikelyWhatsAppCryptoError", () => {
    it("matches known Baileys crypto auth errors (Error)", () => {
      const err = new Error("bad mac");
      err.stack = "at something\nat @whiskeysockets/baileys/noise-handler\n";
      expect(isLikelyWhatsAppCryptoError(err)).toBe(true);
    });

    it("does not throw on circular objects", () => {
      const circular: Record<string, unknown> = {};
      circular.self = circular;
      expect(isLikelyWhatsAppCryptoError(circular)).toBe(false);
    });

    const cases: Array<{ name: string; value: unknown; expected: boolean }> = [
      { name: "returns false for non-matching Error", value: new Error("boom"), expected: false },
      { name: "returns false for non-matching string", value: "boom", expected: false },
      {
        name: "returns false for bad-mac object without whatsapp/baileys markers",
        value: { message: "bad mac" },
        expected: false,
      },
      {
        name: "matches known Baileys crypto auth errors (string, unsupported state)",
        value: "baileys: unsupported state or unable to authenticate data (noise-handler)",
        expected: true,
      },
      {
        name: "matches known Baileys crypto auth errors (string, bad mac)",
        value: "bad mac in aesDecryptGCM (baileys)",
        expected: true,
      },
      { name: "handles null reason without throwing", value: null, expected: false },
      { name: "handles number reason without throwing", value: 123, expected: false },
      { name: "handles boolean reason without throwing", value: true, expected: false },
      { name: "handles bigint reason without throwing", value: 123n, expected: false },
      { name: "handles symbol reason without throwing", value: Symbol("bad mac"), expected: false },
      {
        name: "handles function reason without throwing",
        value: function namedFn() {},
        expected: false,
      },
    ];

    for (const testCase of cases) {
      it(testCase.name, () => {
        expect(isLikelyWhatsAppCryptoError(testCase.value)).toBe(testCase.expected);
      });
    }
  });
});

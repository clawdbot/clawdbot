import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import type { GroupKeyResolution } from "../config/sessions.js";
import { createInboundDebouncer } from "./inbound-debounce.js";
import { applyTemplate, type MsgContext, type TemplateContext } from "./templating.js";
import { finalizeInboundContext } from "./reply/inbound-context.js";
import {
  buildInboundDedupeKey,
  resetInboundDedupe,
  shouldSkipDuplicateInbound,
} from "./reply/inbound-dedupe.js";
import { formatInboundBodyWithSenderMeta } from "./reply/inbound-sender-meta.js";
import { normalizeInboundTextNewlines } from "./reply/inbound-text.js";
import { resolveGroupRequireMention } from "./reply/groups.js";
import {
  buildMentionRegexes,
  matchesMentionPatterns,
  normalizeMentionText,
} from "./reply/mentions.js";
import { initSessionState } from "./reply/session.js";

describe("applyTemplate", () => {
  it("renders primitive values", () => {
    const ctx = { MessageSid: "sid", IsNewSession: "no" } as TemplateContext;
    const overrides = ctx as Record<string, unknown>;
    overrides.MessageSid = 42;
    overrides.IsNewSession = true;

    expect(applyTemplate("sid={{MessageSid}} new={{IsNewSession}}", ctx)).toBe("sid=42 new=true");
  });

  it("renders arrays of primitives", () => {
    const ctx = { MediaPaths: ["a"] } as TemplateContext;
    (ctx as Record<string, unknown>).MediaPaths = ["a", 2, true, null, { ok: false }];

    expect(applyTemplate("paths={{MediaPaths}}", ctx)).toBe("paths=a,2,true");
  });

  it("drops object values", () => {
    const ctx: TemplateContext = { CommandArgs: { raw: "go" } };

    expect(applyTemplate("args={{CommandArgs}}", ctx)).toBe("args=");
  });

  it("renders missing placeholders as empty", () => {
    const ctx: TemplateContext = {};

    expect(applyTemplate("missing={{Missing}}", ctx)).toBe("missing=");
  });
});

describe("normalizeInboundTextNewlines", () => {
  it("keeps real newlines", () => {
    expect(normalizeInboundTextNewlines("a\nb")).toBe("a\nb");
  });

  it("normalizes CRLF/CR to LF", () => {
    expect(normalizeInboundTextNewlines("a\r\nb")).toBe("a\nb");
    expect(normalizeInboundTextNewlines("a\rb")).toBe("a\nb");
  });

  it("decodes literal \\n to newlines when no real newlines exist", () => {
    expect(normalizeInboundTextNewlines("a\\nb")).toBe("a\nb");
  });
});

describe("finalizeInboundContext", () => {
  it("fills BodyForAgent/BodyForCommands and normalizes newlines", () => {
    const ctx: MsgContext = {
      Body: "a\\nb\r\nc",
      RawBody: "raw\\nline",
      ChatType: "channel",
      From: "whatsapp:group:123@g.us",
      GroupSubject: "Test",
    };

    const out = finalizeInboundContext(ctx);
    expect(out.Body).toBe("a\nb\nc");
    expect(out.RawBody).toBe("raw\nline");
    expect(out.BodyForAgent).toBe("a\nb\nc");
    expect(out.BodyForCommands).toBe("raw\nline");
    expect(out.CommandAuthorized).toBe(false);
    expect(out.ChatType).toBe("channel");
    expect(out.ConversationLabel).toContain("Test");
  });

  it("can force BodyForCommands to follow updated CommandBody", () => {
    const ctx: MsgContext = {
      Body: "base",
      BodyForCommands: "<media:audio>",
      CommandBody: "say hi",
      From: "signal:+15550001111",
      ChatType: "direct",
    };

    finalizeInboundContext(ctx, { forceBodyForCommands: true });
    expect(ctx.BodyForCommands).toBe("say hi");
  });
});

describe("formatInboundBodyWithSenderMeta", () => {
  it("does nothing for direct messages", () => {
    const ctx: MsgContext = { ChatType: "direct", SenderName: "Alice", SenderId: "A1" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[X] hi" })).toBe("[X] hi");
  });

  it("appends a sender meta line for non-direct messages", () => {
    const ctx: MsgContext = { ChatType: "group", SenderName: "Alice", SenderId: "A1" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[X] hi" })).toBe(
      "[X] hi\n[from: Alice (A1)]",
    );
  });

  it("prefers SenderE164 in the label when present", () => {
    const ctx: MsgContext = {
      ChatType: "group",
      SenderName: "Bob",
      SenderId: "bob@s.whatsapp.net",
      SenderE164: "+222",
    };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[X] hi" })).toBe(
      "[X] hi\n[from: Bob (+222)]",
    );
  });

  it("appends with a real newline even if the body contains literal \\n", () => {
    const ctx: MsgContext = { ChatType: "group", SenderName: "Bob", SenderId: "+222" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[X] one\\n[X] two" })).toBe(
      "[X] one\\n[X] two\n[from: Bob (+222)]",
    );
  });

  it("does not duplicate a sender meta line when one is already present", () => {
    const ctx: MsgContext = { ChatType: "group", SenderName: "Alice", SenderId: "A1" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[X] hi\n[from: Alice (A1)]" })).toBe(
      "[X] hi\n[from: Alice (A1)]",
    );
  });

  it("does not append when the body already includes a sender prefix", () => {
    const ctx: MsgContext = { ChatType: "group", SenderName: "Alice", SenderId: "A1" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "Alice (A1): hi" })).toBe("Alice (A1): hi");
  });

  it("does not append when the sender prefix follows an envelope header", () => {
    const ctx: MsgContext = { ChatType: "group", SenderName: "Alice", SenderId: "A1" };
    expect(formatInboundBodyWithSenderMeta({ ctx, body: "[Signal Group] Alice (A1): hi" })).toBe(
      "[Signal Group] Alice (A1): hi",
    );
  });
});

describe("inbound dedupe", () => {
  it("builds a stable key when MessageSid is present", () => {
    const ctx: MsgContext = {
      Provider: "telegram",
      OriginatingChannel: "telegram",
      OriginatingTo: "telegram:123",
      MessageSid: "42",
    };
    expect(buildInboundDedupeKey(ctx)).toBe("telegram|telegram:123|42");
  });

  it("skips duplicates with the same key", () => {
    resetInboundDedupe();
    const ctx: MsgContext = {
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+1555",
      MessageSid: "msg-1",
    };
    expect(shouldSkipDuplicateInbound(ctx, { now: 100 })).toBe(false);
    expect(shouldSkipDuplicateInbound(ctx, { now: 200 })).toBe(true);
  });

  it("does not dedupe when the peer changes", () => {
    resetInboundDedupe();
    const base: MsgContext = {
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      MessageSid: "msg-1",
    };
    expect(
      shouldSkipDuplicateInbound({ ...base, OriginatingTo: "whatsapp:+1000" }, { now: 100 }),
    ).toBe(false);
    expect(
      shouldSkipDuplicateInbound({ ...base, OriginatingTo: "whatsapp:+2000" }, { now: 200 }),
    ).toBe(false);
  });

  it("does not dedupe across session keys", () => {
    resetInboundDedupe();
    const base: MsgContext = {
      Provider: "whatsapp",
      OriginatingChannel: "whatsapp",
      OriginatingTo: "whatsapp:+1555",
      MessageSid: "msg-1",
    };
    expect(
      shouldSkipDuplicateInbound({ ...base, SessionKey: "agent:alpha:main" }, { now: 100 }),
    ).toBe(false);
    expect(
      shouldSkipDuplicateInbound({ ...base, SessionKey: "agent:bravo:main" }, { now: 200 }),
    ).toBe(false);
    expect(
      shouldSkipDuplicateInbound({ ...base, SessionKey: "agent:alpha:main" }, { now: 300 }),
    ).toBe(true);
  });
});

describe("createInboundDebouncer", () => {
  it("debounces and combines items", async () => {
    vi.useFakeTimers();
    const calls: Array<string[]> = [];

    const debouncer = createInboundDebouncer<{ key: string; id: string }>({
      debounceMs: 10,
      buildKey: (item) => item.key,
      onFlush: async (items) => {
        calls.push(items.map((entry) => entry.id));
      },
    });

    await debouncer.enqueue({ key: "a", id: "1" });
    await debouncer.enqueue({ key: "a", id: "2" });

    expect(calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([["1", "2"]]);

    vi.useRealTimers();
  });

  it("flushes buffered items before non-debounced item", async () => {
    vi.useFakeTimers();
    const calls: Array<string[]> = [];

    const debouncer = createInboundDebouncer<{ key: string; id: string; debounce: boolean }>({
      debounceMs: 50,
      buildKey: (item) => item.key,
      shouldDebounce: (item) => item.debounce,
      onFlush: async (items) => {
        calls.push(items.map((entry) => entry.id));
      },
    });

    await debouncer.enqueue({ key: "a", id: "1", debounce: true });
    await debouncer.enqueue({ key: "a", id: "2", debounce: false });

    expect(calls).toEqual([["1"], ["2"]]);

    vi.useRealTimers();
  });
});

describe("initSessionState sender meta", () => {
  it("injects sender meta into BodyStripped for group chats", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-sender-meta-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as MoltbotConfig;

    const result = await initSessionState({
      ctx: {
        Body: "[WhatsApp 123@g.us] ping",
        ChatType: "group",
        SenderName: "Bob",
        SenderE164: "+222",
        SenderId: "222@s.whatsapp.net",
        SessionKey: "agent:main:whatsapp:group:123@g.us",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionCtx.BodyStripped).toBe("[WhatsApp 123@g.us] ping\n[from: Bob (+222)]");
  });

  it("does not inject sender meta for direct chats", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "moltbot-sender-meta-direct-"));
    const storePath = path.join(root, "sessions.json");
    const cfg = { session: { store: storePath } } as MoltbotConfig;

    const result = await initSessionState({
      ctx: {
        Body: "[WhatsApp +1] ping",
        ChatType: "direct",
        SenderName: "Bob",
        SenderE164: "+222",
        SessionKey: "agent:main:whatsapp:dm:+222",
      },
      cfg,
      commandAuthorized: true,
    });

    expect(result.sessionCtx.BodyStripped).toBe("[WhatsApp +1] ping");
  });
});

describe("mention helpers", () => {
  it("builds regexes and skips invalid patterns", () => {
    const regexes = buildMentionRegexes({
      messages: {
        groupChat: { mentionPatterns: ["\\bclawd\\b", "(invalid"] },
      },
    });
    expect(regexes).toHaveLength(1);
    expect(regexes[0]?.test("clawd")).toBe(true);
  });

  it("normalizes zero-width characters", () => {
    expect(normalizeMentionText("cl\u200bawd")).toBe("clawd");
  });

  it("matches patterns case-insensitively", () => {
    const regexes = buildMentionRegexes({
      messages: { groupChat: { mentionPatterns: ["\\bclawd\\b"] } },
    });
    expect(matchesMentionPatterns("CLAWD: hi", regexes)).toBe(true);
  });

  it("uses per-agent mention patterns when configured", () => {
    const regexes = buildMentionRegexes(
      {
        messages: {
          groupChat: { mentionPatterns: ["\\bglobal\\b"] },
        },
        agents: {
          list: [
            {
              id: "work",
              groupChat: { mentionPatterns: ["\\bworkbot\\b"] },
            },
          ],
        },
      },
      "work",
    );
    expect(matchesMentionPatterns("workbot: hi", regexes)).toBe(true);
    expect(matchesMentionPatterns("global: hi", regexes)).toBe(false);
  });
});

describe("resolveGroupRequireMention", () => {
  it("respects Discord guild/channel requireMention settings", () => {
    const cfg: MoltbotConfig = {
      channels: {
        discord: {
          guilds: {
            "145": {
              requireMention: false,
              channels: {
                general: { allow: true },
              },
            },
          },
        },
      },
    };
    const ctx: TemplateContext = {
      Provider: "discord",
      From: "discord:group:123",
      GroupChannel: "#general",
      GroupSpace: "145",
    };
    const groupResolution: GroupKeyResolution = {
      channel: "discord",
      id: "123",
      chatType: "group",
    };

    expect(resolveGroupRequireMention({ cfg, ctx, groupResolution })).toBe(false);
  });

  it("respects Slack channel requireMention settings", () => {
    const cfg: MoltbotConfig = {
      channels: {
        slack: {
          channels: {
            C123: { requireMention: false },
          },
        },
      },
    };
    const ctx: TemplateContext = {
      Provider: "slack",
      From: "slack:channel:C123",
      GroupSubject: "#general",
    };
    const groupResolution: GroupKeyResolution = {
      channel: "slack",
      id: "C123",
      chatType: "group",
    };

    expect(resolveGroupRequireMention({ cfg, ctx, groupResolution })).toBe(false);
  });
});

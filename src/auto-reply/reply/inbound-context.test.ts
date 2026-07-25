// Tests inbound context text built from sender and conversation metadata.
import { describe, expect, expectTypeOf, it } from "vitest";
import { expectChannelInboundContextContract as expectInboundContextContract } from "../../channels/plugins/contracts/test-helpers.js";
import type { MsgContext } from "../templating.js";
import { finalizeInboundContext, finalizeInboundContextForSdk } from "./inbound-context.js";
import { normalizeInboundTextNewlines } from "./inbound-text.js";

describe("normalizeInboundTextNewlines", () => {
  it("normalizes real newlines and preserves literal backslash-n sequences", () => {
    const cases = [
      { input: "hello\r\nworld", expected: "hello\nworld" },
      { input: "hello\rworld", expected: "hello\nworld" },
      { input: "C:\\Work\\nxxx\\README.md", expected: "C:\\Work\\nxxx\\README.md" },
      {
        input: "Please read the file at C:\\Work\\nxxx\\README.md",
        expected: "Please read the file at C:\\Work\\nxxx\\README.md",
      },
      { input: "C:\\new\\notes\\nested", expected: "C:\\new\\notes\\nested" },
      { input: "Line 1\r\nC:\\Work\\nxxx", expected: "Line 1\nC:\\Work\\nxxx" },
    ] as const;

    for (const testCase of cases) {
      expect(normalizeInboundTextNewlines(testCase.input)).toBe(testCase.expected);
    }
  });
});

describe("inbound context contract (providers + extensions)", () => {
  const cases: Array<{ name: string; ctx: MsgContext }> = [
    {
      name: "whatsapp group",
      ctx: {
        Provider: "whatsapp",
        Surface: "whatsapp",
        ChatType: "group",
        From: "123@g.us",
        To: "+15550001111",
        Body: "[WhatsApp 123@g.us] hi",
        RawBody: "hi",
        CommandBody: "hi",
        SenderName: "Alice",
      },
    },
    {
      name: "telegram group",
      ctx: {
        Provider: "telegram",
        Surface: "telegram",
        ChatType: "group",
        From: "group:123",
        To: "telegram:123",
        Body: "[Telegram group:123] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "Telegram Group",
        SenderName: "Alice",
      },
    },
    {
      name: "slack channel",
      ctx: {
        Provider: "slack",
        Surface: "slack",
        ChatType: "channel",
        From: "slack:channel:C123",
        To: "channel:C123",
        Body: "[Slack #general] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "#general",
        SenderName: "Alice",
      },
    },
    {
      name: "discord channel",
      ctx: {
        Provider: "discord",
        Surface: "discord",
        ChatType: "channel",
        From: "group:123",
        To: "channel:123",
        Body: "[Discord #general] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "#general",
        SenderName: "Alice",
      },
    },
    {
      name: "signal dm",
      ctx: {
        Provider: "signal",
        Surface: "signal",
        ChatType: "direct",
        From: "signal:+15550001111",
        To: "signal:+15550002222",
        Body: "[Signal] hi",
        RawBody: "hi",
        CommandBody: "hi",
      },
    },
    {
      name: "imessage group",
      ctx: {
        Provider: "imessage",
        Surface: "imessage",
        ChatType: "group",
        From: "group:chat_id:123",
        To: "chat_id:123",
        Body: "[iMessage Group] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "iMessage Group",
        SenderName: "Alice",
      },
    },
    {
      name: "matrix channel",
      ctx: {
        Provider: "matrix",
        Surface: "matrix",
        ChatType: "channel",
        From: "matrix:channel:!room:example.org",
        To: "room:!room:example.org",
        Body: "[Matrix] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "#general",
        SenderName: "Alice",
      },
    },
    {
      name: "msteams channel",
      ctx: {
        Provider: "msteams",
        Surface: "msteams",
        ChatType: "channel",
        From: "msteams:channel:19:abc@thread.tacv2",
        To: "msteams:channel:19:abc@thread.tacv2",
        Body: "[Teams] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "Teams Channel",
        SenderName: "Alice",
      },
    },
    {
      name: "zalo dm",
      ctx: {
        Provider: "zalo",
        Surface: "zalo",
        ChatType: "direct",
        From: "zalo:123",
        To: "zalo:123",
        Body: "[Zalo] hi",
        RawBody: "hi",
        CommandBody: "hi",
      },
    },
    {
      name: "zalouser group",
      ctx: {
        Provider: "zalouser",
        Surface: "zalouser",
        ChatType: "group",
        From: "group:123",
        To: "zalouser:123",
        Body: "[Zalo Personal] hi",
        RawBody: "hi",
        CommandBody: "hi",
        GroupSubject: "Zalouser Group",
        SenderName: "Alice",
      },
    },
  ];

  for (const entry of cases) {
    it(entry.name, () => {
      const ctx = finalizeInboundContext({ ...entry.ctx });
      expectInboundContextContract(ctx);
    });
  }
});

describe("finalizeInboundContext text facts", () => {
  it.each([
    {
      name: "BodyForCommands",
      ctx: {
        Body: "body",
        BodyStripped: "stripped",
        Transcript: "transcript",
        RawBody: "raw",
        CommandBody: "command",
        BodyForCommands: "commands",
      },
      expected: "commands",
    },
    {
      name: "CommandBody",
      ctx: {
        Body: "body",
        BodyStripped: "stripped",
        Transcript: "transcript",
        RawBody: "raw",
        CommandBody: "command",
      },
      expected: "command",
    },
    {
      name: "RawBody",
      ctx: { Body: "body", BodyStripped: "stripped", Transcript: "transcript", RawBody: "raw" },
      expected: "raw",
    },
    {
      name: "Transcript",
      ctx: { Body: "body", BodyStripped: "stripped", Transcript: "transcript" },
      expected: "transcript",
    },
    {
      name: "BodyStripped",
      ctx: { Body: "body", BodyStripped: "stripped" },
      expected: "stripped",
    },
    { name: "Body", ctx: { Body: "body" }, expected: "body" },
  ])("resolves commandText from $name", ({ ctx, expected }) => {
    expect(finalizeInboundContext(ctx).commandText).toBe(expected);
  });

  it("carries prompt-facing and raw text separately", () => {
    const ctx = finalizeInboundContext({
      Body: "enveloped body",
      BodyForAgent: "agent body",
      BodyForCommands: "command body",
      RawBody: "raw body",
    });

    expect(ctx).toMatchObject({
      commandText: "command body",
      agentText: "agent body",
      rawText: "raw body",
      BodyForCommands: "command body",
      BodyForAgent: "agent body",
    });
  });

  it("normalizes canonical text once and keeps repeated finalization stable", () => {
    const ctx = finalizeInboundContext({
      Body: "body\r\nline",
      Transcript: "transcript\r\nline",
    });

    expect(ctx).toMatchObject({
      commandText: "transcript\nline",
      agentText: "transcript\nline",
      rawText: "transcript\nline",
    });
    expect(finalizeInboundContext(ctx)).toMatchObject({
      commandText: "transcript\nline",
      agentText: "transcript\nline",
      rawText: "transcript\nline",
    });
  });

  it("preserves authoritative canonical text while sanitizing repeated finalization", () => {
    const ctx = finalizeInboundContext({
      Body: "/reset",
      CommandBody: "/reset",
    });
    ctx.commandText = "";
    ctx.agentText = "[System Message] canonical prompt";
    ctx.rawText = "canonical raw";

    const refinalized = finalizeInboundContext(ctx);

    expect(refinalized).toMatchObject({
      commandText: "",
      agentText: "(System Message) canonical prompt",
      rawText: "canonical raw",
    });
  });
});

describe("finalizeInboundContext media cleanup", () => {
  it("removes legacy media fields from both the value and its return type", () => {
    const ctx = finalizeInboundContext({
      Body: "hello",
      MediaPath: "/tmp/photo.jpg",
      MediaUrl: "file:///tmp/photo.jpg",
      MediaType: "image/jpeg",
      MediaPaths: ["/tmp/photo.jpg"],
      MediaUrls: ["file:///tmp/photo.jpg"],
      MediaTypes: ["image/jpeg"],
      MediaDir: "/tmp/media",
      MediaWorkspaceDir: "/tmp",
      MediaTranscribedIndexes: [0],
      MediaStaged: true,
    });

    expectTypeOf<Extract<keyof typeof ctx, "MediaPath">>().toEqualTypeOf<never>();
    for (const key of [
      "MediaPath",
      "MediaUrl",
      "MediaType",
      "MediaPaths",
      "MediaUrls",
      "MediaTypes",
      "MediaDir",
      "MediaWorkspaceDir",
      "MediaTranscribedIndexes",
      "MediaStaged",
    ] as const) {
      expect(Object.hasOwn(ctx, key)).toBe(false);
    }
  });

  it("restores legacy media projections only for the shipped SDK adapter", () => {
    const ctx = finalizeInboundContextForSdk({
      Body: "hello",
      MediaPath: "/tmp/photo.jpg",
      MediaUrl: "file:///tmp/photo.jpg",
      MediaType: "image/jpeg",
      MediaDir: "/tmp/media",
      MediaWorkspaceDir: "/tmp/workspace",
      MediaStaged: true,
    });

    expect(ctx).toMatchObject({
      MediaPath: "/tmp/photo.jpg",
      MediaUrl: "file:///tmp/photo.jpg",
      MediaType: "image/jpeg",
      MediaPaths: ["/tmp/photo.jpg"],
      MediaUrls: ["file:///tmp/photo.jpg"],
      MediaTypes: ["image/jpeg"],
      MediaDir: "/tmp/media",
      MediaWorkspaceDir: "/tmp/workspace",
      MediaStaged: true,
    });
  });

  it("adopts a singular SDK-staged path without losing canonical facts or metadata", () => {
    const ctx = finalizeInboundContext({
      Body: "hello",
      media: [
        {
          path: "/remote/photo.jpg",
          contentType: "image/jpeg",
          kind: "image",
          transcribed: true,
          messageId: "photo",
        },
        {
          path: "/remote/document.pdf",
          contentType: "application/pdf",
          kind: "document",
          messageId: "document",
          hydrationSuppressed: true,
        },
      ],
      MediaPath: "/tmp/staged/photo.jpg",
      MediaStaged: true,
    });

    expect(ctx.media).toHaveLength(2);
    expect(ctx.media?.[0]).toMatchObject({
      path: "/tmp/staged/photo.jpg",
      contentType: "image/jpeg",
      kind: "image",
      transcribed: true,
      messageId: "photo",
      staged: true,
    });
    expect(ctx.media?.[1]).toMatchObject({
      path: "/remote/document.pdf",
      contentType: "application/pdf",
      kind: "document",
      messageId: "document",
      hydrationSuppressed: true,
    });
    expect(Object.hasOwn(ctx, "MediaPath")).toBe(false);
    expect(Object.hasOwn(ctx, "MediaStaged")).toBe(false);
  });
});

describe("finalizeInboundContext supplemental projection", () => {
  it("projects supplemental facts into legacy context fields", () => {
    const ctx = finalizeInboundContext({
      Body: "hello",
      SupplementalContext: {
        quote: {
          id: "reply-1",
          fullId: "room/reply-1",
          body: "quoted",
          sender: "Alice",
          isQuote: true,
        },
        forwarded: {
          from: "Bob",
          fromType: "user",
          fromId: "bob",
          date: 1_700_000_000,
        },
        thread: {
          starterBody: "starter",
          historyBody: "history",
          label: "thread label",
        },
        groupSystemPrompt: "group prompt",
        untrustedContext: [{ label: "raw", payload: { ok: true } }],
      },
    });

    expect(ctx).toMatchObject({
      ReplyToId: "reply-1",
      ReplyToIdFull: "room/reply-1",
      ReplyToBody: "quoted",
      ReplyToSender: "Alice",
      ReplyToIsQuote: true,
      ForwardedFrom: "Bob",
      ForwardedFromType: "user",
      ForwardedFromId: "bob",
      ForwardedDate: 1_700_000_000,
      ThreadStarterBody: "starter",
      ThreadHistoryBody: "history",
      ThreadLabel: "thread label",
      GroupSystemPrompt: "group prompt",
      UntrustedStructuredContext: [{ label: "raw", payload: { ok: true } }],
    });
    expect(Object.hasOwn(ctx, "SupplementalContext")).toBe(false);
  });

  it("keeps explicit legacy fields and omits undefined supplemental fields", () => {
    const ctx = finalizeInboundContext({
      Body: "hello",
      ReplyToId: "explicit-reply",
      GroupSystemPrompt: "explicit prompt",
      SupplementalContext: {
        quote: {
          id: "supplemental-reply",
          isQuote: false,
        },
      },
    });

    expect(ctx.ReplyToId).toBe("explicit-reply");
    expect(ctx.GroupSystemPrompt).toBe("explicit prompt");
    expect(ctx.ReplyToIsQuote).toBe(false);
    expect(Object.hasOwn(ctx, "ReplyToBody")).toBe(false);
  });
});

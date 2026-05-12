import { beforeEach, describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../reply-payload.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";

const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
};

function expectFields(value: unknown, expected: Record<string, unknown>): void {
  if (!value || typeof value !== "object") {
    throw new Error("expected fields object");
  }
  const record = value as Record<string, unknown>;
  for (const [key, expectedValue] of Object.entries(expected)) {
    expect(record[key], key).toEqual(expectedValue);
  }
}

async function expectSameTargetRepliesDelivered(params: { provider: string; to: string }) {
  const { replyPayloads } = await buildReplyPayloads({
    ...baseParams,
    payloads: [{ text: "hello world!" }],
    messageProvider: "heartbeat",
    originatingChannel: "feishu",
    originatingTo: "ou_abc123",
    messagingToolSentTexts: ["different message"],
    messagingToolSentTargets: [{ tool: "message", provider: params.provider, to: params.to }],
  });

  expect(replyPayloads).toHaveLength(1);
  expect(replyPayloads[0]?.text).toBe("hello world!");
}

describe("buildReplyPayloads media filter integration", () => {
  beforeEach(() => {
    resetPluginRuntimeStateForTest();
  });

  it("strips legacy bracket tool blocks from heartbeat replies", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      isHeartbeat: true,
      payloads: [
        {
          text: [
            "Before",
            '[TOOL_CALL]{tool => "exec", args => {"command":"ls"}}[/TOOL_CALL]',
            '[TOOL_RESULT]{"output":"secret result"}[/TOOL_RESULT]',
            "After",
          ].join("\n"),
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("Before\n\n\nAfter");
  });

  it("preserves internal delivery metadata through final payload normalization", async () => {
    const payload = markReplyPayloadForSourceSuppressionDelivery({
      text: "⚠️ API rate limit reached.\n[[reply_to_current]]",
    });

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [payload],
      replyToMode: "all",
      currentMessageId: "msg-1",
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "⚠️ API rate limit reached.",
      replyToId: "msg-1",
    });
    expectFields(getReplyPayloadMetadata(replyPayloads[0]), {
      deliverDespiteSourceReplySuppression: true,
    });
  });

  it("strips media URL from payload when in messagingToolSentMediaUrls", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0].mediaUrl).toBeUndefined();
  });

  it("preserves media URL when not in messagingToolSentMediaUrls", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/other.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0].mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("normalizes sent media URLs before deduping normalized reply media", async () => {
    const normalizeMediaPaths = async (payload: { mediaUrl?: string; mediaUrls?: string[] }) => {
      const normalizeMedia = (value?: string) =>
        value === "./out/photo.jpg" ? "/tmp/workspace/out/photo.jpg" : value;
      return {
        ...payload,
        mediaUrl: normalizeMedia(payload.mediaUrl),
        mediaUrls: payload.mediaUrls?.map((value) => normalizeMedia(value) ?? value),
      };
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "./out/photo.jpg" }],
      messagingToolSentMediaUrls: ["./out/photo.jpg"],
      normalizeMediaPaths,
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "hello",
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });

  it("drops only invalid media when reply media normalization fails", async () => {
    const normalizeMediaPaths = async (payload: { mediaUrl?: string }) => {
      if (payload.mediaUrl === "./bad.png") {
        throw new Error("Path escapes sandbox root");
      }
      return payload;
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [
        { text: "keep text", mediaUrl: "./bad.png", audioAsVoice: true },
        { text: "keep second" },
      ],
      normalizeMediaPaths,
    });

    expect(replyPayloads).toHaveLength(2);
    expectFields(replyPayloads[0], {
      text: "keep text",
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    });
    expectFields(replyPayloads[1], {
      text: "keep second",
    });
  });

  it("drops duplicate caption text after matching media is stripped", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("keeps captioned media when only the caption matches a messaging tool send", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentMediaUrls: ["file:///tmp/other.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "hello world!",
      mediaUrl: "file:///tmp/photo.jpg",
    });
  });

  it("does not dedupe text for cross-target messaging sends", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "telegram",
      originatingTo: "telegram:123",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [{ tool: "discord", provider: "discord", to: "channel:C1" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });

  it("does not dedupe media for cross-target messaging sends", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
      messageProvider: "telegram",
      originatingTo: "telegram:123",
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
      messagingToolSentTargets: [{ tool: "slack", provider: "slack", to: "channel:C1" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.mediaUrl).toBe("file:///tmp/photo.jpg");
  });

  it("dedupes final text only against message-tool text sent to the same route", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "discord-only text" }],
      messageProvider: "slack",
      originatingTo: "channel:C1",
      messagingToolSentTexts: ["slack text", "discord-only text"],
      messagingToolSentTargets: [
        { tool: "slack", provider: "slack", to: "channel:C1", text: "slack text" },
        {
          tool: "discord",
          provider: "discord",
          to: "channel:C2",
          text: "discord-only text",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("discord-only text");
  });

  it("falls back to global text dedupe for legacy multi-target messaging telemetry", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "slack",
      originatingTo: "channel:C1",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [
        { tool: "slack", provider: "slack", to: "channel:C1" },
        { tool: "discord", provider: "discord", to: "channel:C2" },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("dedupes final media only against message-tool media sent to the same route", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "photo", mediaUrl: "file:///tmp/discord-photo.jpg" }],
      messageProvider: "slack",
      originatingTo: "channel:C1",
      messagingToolSentMediaUrls: ["file:///tmp/slack-photo.jpg", "file:///tmp/discord-photo.jpg"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          mediaUrls: ["file:///tmp/slack-photo.jpg"],
        },
        {
          tool: "discord",
          provider: "discord",
          to: "channel:C2",
          mediaUrls: ["file:///tmp/discord-photo.jpg"],
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.mediaUrl).toBe("file:///tmp/discord-photo.jpg");
  });

  it("falls back to global media dedupe for legacy multi-target messaging telemetry", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "photo", mediaUrl: "file:///tmp/photo.jpg" }],
      messageProvider: "slack",
      originatingTo: "channel:C1",
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
      messagingToolSentTargets: [
        { tool: "slack", provider: "slack", to: "channel:C1" },
        { tool: "discord", provider: "discord", to: "channel:C2" },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "photo",
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });

  it("delivers distinct same-target replies when messageProvider is synthetic but originatingChannel is set", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "heartbeat",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });

  it("delivers distinct same-target replies when message tool target provider is generic", async () => {
    await expectSameTargetRepliesDelivered({ provider: "message", to: "ou_abc123" });
  });

  it("delivers distinct same-target replies when target provider is channel alias", async () => {
    resetPluginRuntimeStateForTest();
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "feishu-plugin",
          source: "test",
          plugin: {
            id: "feishu",
            meta: {
              id: "feishu",
              label: "Feishu",
              selectionLabel: "Feishu",
              docsPath: "/channels/feishu",
              blurb: "test stub",
              aliases: ["lark"],
            },
            capabilities: { chatTypes: ["direct"] },
            config: { listAccountIds: () => [], resolveAccount: () => ({}) },
          },
        },
      ]),
    );
    await expectSameTargetRepliesDelivered({ provider: "lark", to: "ou_abc123" });
  });

  it("dedupes duplicate same-target reply text without suppressing unrelated finals", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentTargets: [
        { tool: "telegram", provider: "telegram", to: "268300329", text: "hello world!" },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("does not dedupe short commentary that appears inside a longer same-target message", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "v2ex hot topics delivered to telegram" }],
      messageProvider: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: [
        "1. some article title\n2. another title\nv2ex hot topics delivered to telegram\n3. yet another",
      ],
      messagingToolSentTargets: [
        {
          tool: "telegram",
          provider: "telegram",
          to: "268300329",
          text: "1. some article title\n2. another title\nv2ex hot topics delivered to telegram\n3. yet another",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("v2ex hot topics delivered to telegram");
  });

  it("strips media already sent by the block pipeline after normalizing both paths", async () => {
    const normalizeMediaPaths = async (payload: { mediaUrl?: string; mediaUrls?: string[] }) => {
      const rewrite = (value?: string) =>
        value === "file:///tmp/voice.ogg" ? "file:///tmp/outbound/voice.ogg" : value;
      return {
        ...payload,
        mediaUrl: rewrite(payload.mediaUrl),
        mediaUrls: payload.mediaUrls?.map((value) => rewrite(value) ?? value),
      };
    };
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => false,
      isAborted: () => false,
      hasSentPayload: () => false,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      getSentMediaUrls: () => ["file:///tmp/voice.ogg"],
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      normalizeMediaPaths,
      payloads: [{ text: "caption", mediaUrl: "file:///tmp/voice.ogg" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "caption",
      mediaUrl: undefined,
      mediaUrls: undefined,
    });
  });

  it("suppresses already-sent text plus media before stripping block-sent media", async () => {
    const sentKey = JSON.stringify({
      text: "caption",
      mediaList: ["file:///tmp/outbound/voice.ogg"],
    });
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => false,
      isAborted: () => false,
      hasSentPayload: (payload) =>
        JSON.stringify({
          text: (payload.text ?? "").trim(),
          mediaList: [
            ...(payload.mediaUrl ? [payload.mediaUrl] : []),
            ...(payload.mediaUrls ?? []),
          ],
        }) === sentKey,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      getSentMediaUrls: () => ["file:///tmp/outbound/voice.ogg"],
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      normalizeMediaPaths: async (payload) => payload,
      payloads: [{ text: "caption", mediaUrl: "file:///tmp/outbound/voice.ogg" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("drops all final payloads when block pipeline streamed successfully", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: () => false,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      getSentMediaUrls: () => [],
    };
    // shouldDropFinalPayloads short-circuits to [] when the pipeline streamed
    // without aborting, so hasSentPayload is never reached.
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "all",
      payloads: [{ text: "response", replyToId: "post-123" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("keeps unsent final media after block pipeline streamed the text", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: (payload) => payload.text === "response" && !payload.mediaUrl,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      getSentMediaUrls: () => [],
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      payloads: [{ text: "response", mediaUrl: "/tmp/generated.png" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      mediaUrl: "/tmp/generated.png",
      text: undefined,
    });
  });

  it("drops already-sent final media after block pipeline streamed successfully", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: (payload) => payload.text === "response" && !payload.mediaUrl,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      getSentMediaUrls: () => ["/tmp/generated.png"],
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      payloads: [{ text: "response", mediaUrl: "/tmp/generated.png" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("preserves post-stream error payloads when block pipeline streamed successfully", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: () => false,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      getSentMediaUrls: () => [],
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "all",
      payloads: [{ text: "Agent couldn't generate a response. Please try again.", isError: true }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "Agent couldn't generate a response. Please try again.",
      isError: true,
    });
  });

  it("drops non-voice final payloads during silent turns, including media-only payloads", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      silentExpected: true,
      payloads: [{ text: "NO_REPLY", mediaUrl: "file:///tmp/photo.jpg" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("keeps error payloads during silent turns", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      silentExpected: true,
      payloads: [
        { text: "normal maintenance reply" },
        {
          text: "⚠️ write failed: Memory flush writes are restricted to memory/2026-05-05.md; use that path only.",
          isError: true,
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "⚠️ write failed: Memory flush writes are restricted to memory/2026-05-05.md; use that path only.",
      isError: true,
    });
  });

  it("keeps voice media payloads during silent turns", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      silentExpected: true,
      payloads: [{ text: "NO_REPLY", mediaUrl: "file:///tmp/voice.opus", audioAsVoice: true }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: undefined,
      mediaUrl: "file:///tmp/voice.opus",
      audioAsVoice: true,
    });
  });

  it("drops empty voice markers during silent turns", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      silentExpected: true,
      payloads: [{ audioAsVoice: true }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("suppresses warning text when silent media payloads fail normalization", async () => {
    const normalizeMediaPaths = async () => {
      throw new Error("file not found");
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "NO_REPLY\nMEDIA: ./missing.png" }],
      normalizeMediaPaths,
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("extracts markdown image replies into final payload media urls", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      extractMarkdownImages: true,
      payloads: [{ text: "Here you go\n\n![chart](https://example.com/chart.png)" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "Here you go",
      mediaUrl: "https://example.com/chart.png",
      mediaUrls: ["https://example.com/chart.png"],
    });
  });

  it("preserves inline caption text when lifting markdown image replies into media", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      extractMarkdownImages: true,
      payloads: [{ text: 'Look ![chart](https://example.com/chart.png "Quarterly chart") now' }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "Look now",
      mediaUrl: "https://example.com/chart.png",
      mediaUrls: ["https://example.com/chart.png"],
    });
  });

  it("keeps markdown local file images as plain text in final replies", async () => {
    const text = "Look ![chart](file:///etc/passwd) now";
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      extractMarkdownImages: true,
      payloads: [{ text }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text,
    });
    expect(replyPayloads[0]?.mediaUrl).toBeUndefined();
    expect(replyPayloads[0]?.mediaUrls).toBeUndefined();
  });

  it("deduplicates final payloads against directly sent block keys regardless of replyToId", async () => {
    // When block streaming is not active but directlySentBlockKeys has entries
    // (e.g. from pre-tool flush), the key should match even if replyToId differs.
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>();
    directlySentBlockKeys.add(
      createBlockReplyContentKey({ text: "response", replyToId: "post-1" }),
    );

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: false,
      blockReplyPipeline: null,
      directlySentBlockKeys,
      replyToMode: "off",
      payloads: [{ text: "response" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("deduplicates final payloads against directly sent block keys when streaming is enabled without a pipeline", async () => {
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>();
    directlySentBlockKeys.add(
      createBlockReplyContentKey({ text: "response", replyToId: "post-1" }),
    );

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: null,
      directlySentBlockKeys,
      replyToMode: "off",
      payloads: [{ text: "response" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("does not suppress same-target replies when accountId differs", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "heartbeat",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      accountId: "personal",
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [
        {
          tool: "telegram",
          provider: "telegram",
          to: "268300329",
          accountId: "work",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
  });
});

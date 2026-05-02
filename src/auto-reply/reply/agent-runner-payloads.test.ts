import { describe, expect, it } from "vitest";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import { createTestRegistry } from "../../test-utils/channel-plugins.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";

const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
};

async function expectSameTargetRepliesSuppressed(params: { provider: string; to: string }) {
  const { replyPayloads } = await buildReplyPayloads({
    ...baseParams,
    payloads: [{ text: "hello world!" }],
    messageProvider: "heartbeat",
    originatingChannel: "feishu",
    originatingTo: "ou_abc123",
    messagingToolSentTexts: ["different message"],
    messagingToolSentTargets: [{ tool: "message", provider: params.provider, to: params.to }],
  });

  expect(replyPayloads).toHaveLength(0);
}

describe("buildReplyPayloads media filter integration", () => {
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
    expect(replyPayloads[0]).toMatchObject({
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
    expect(replyPayloads[0]).toMatchObject({
      text: "keep text",
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    });
    expect(replyPayloads[1]).toMatchObject({
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
    expect(replyPayloads[0]).toMatchObject({
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

  it("suppresses same-target replies when messageProvider is synthetic but originatingChannel is set", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello world!" }],
      messageProvider: "heartbeat",
      originatingChannel: "telegram",
      originatingTo: "268300329",
      messagingToolSentTexts: ["different message"],
      messagingToolSentTargets: [{ tool: "telegram", provider: "telegram", to: "268300329" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("suppresses same-target replies when message tool target provider is generic", async () => {
    await expectSameTargetRepliesSuppressed({ provider: "message", to: "ou_abc123" });
  });

  it("suppresses same-target replies when target provider is channel alias", async () => {
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
    await expectSameTargetRepliesSuppressed({ provider: "lark", to: "ou_abc123" });
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
    expect(replyPayloads[0]).toMatchObject({
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
    expect(replyPayloads[0]).toMatchObject({
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
    expect(replyPayloads[0]).toMatchObject({
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

  it("keeps voice media payloads during silent turns", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      silentExpected: true,
      payloads: [{ text: "NO_REPLY", mediaUrl: "file:///tmp/voice.opus", audioAsVoice: true }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]).toMatchObject({
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
    expect(replyPayloads[0]).toMatchObject({
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
    expect(replyPayloads[0]).toMatchObject({
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
    expect(replyPayloads[0]).toMatchObject({
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

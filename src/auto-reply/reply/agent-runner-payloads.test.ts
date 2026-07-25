// Tests reply payload construction and metadata propagation from agent runs.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import type { ChannelThreadingAdapter } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";

const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
};

type ResolveReplyTransportParams = Parameters<
  NonNullable<ChannelThreadingAdapter["resolveReplyTransport"]>
>[0];

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
    setActivePluginRegistry(
      createTestRegistry([
        {
          pluginId: "slack",
          plugin: {
            ...createChannelTestPluginBase({ id: "slack" }),
            threading: {
              resolveReplyTransport: ({
                threadId,
                replyToId,
                replyDelivery,
              }: ResolveReplyTransportParams) => ({
                replyToId:
                  replyDelivery?.replyToMode === "off"
                    ? threadId != null
                      ? String(threadId)
                      : undefined
                    : (replyToId ?? (threadId != null ? String(threadId) : undefined)),
                threadId: null,
              }),
            },
          },
          source: "test",
        },
        {
          pluginId: "mattermost",
          plugin: {
            ...createChannelTestPluginBase({ id: "mattermost" }),
            threading: {
              resolveReplyTransport: ({
                threadId,
                replyToId,
                replyToIsExplicit,
                replyDelivery,
              }: ResolveReplyTransportParams) => {
                const ambientThreadId = threadId != null ? String(threadId) : undefined;
                const resolvedThreadId =
                  replyDelivery?.chatType === "direct"
                    ? undefined
                    : replyToIsExplicit
                      ? (replyToId ?? ambientThreadId)
                      : replyDelivery
                        ? (ambientThreadId ?? replyToId ?? undefined)
                        : (replyToId ?? ambientThreadId);
                return {
                  replyToId: resolvedThreadId,
                  threadId: resolvedThreadId ?? null,
                };
              },
            },
          },
          source: "test",
        },
        {
          pluginId: "telegram",
          plugin: createChannelTestPluginBase({ id: "telegram" }),
          source: "test",
        },
        {
          pluginId: "discord",
          plugin: createChannelTestPluginBase({ id: "discord" }),
          source: "test",
        },
        {
          pluginId: "feishu-plugin",
          source: "test",
          plugin: {
            ...createChannelTestPluginBase({ id: "feishu" }),
            meta: {
              id: "feishu",
              label: "Feishu",
              selectionLabel: "Feishu",
              docsPath: "/channels/feishu",
              blurb: "test stub",
              aliases: ["lark"],
            },
          },
        },
      ]),
    );
  });

  it("shares first-reply threading across staged payload builds", async () => {
    const applyReplyToMode = createReplyToModeFilterForChannel("first", "whatsapp");
    const sharedParams = {
      ...baseParams,
      replyToMode: "first" as const,
      replyToChannel: "whatsapp" as const,
      currentMessageId: "msg",
      applyReplyToMode,
    };
    const first = await buildReplyPayloads({
      ...sharedParams,
      payloads: [{ text: "internal commentary", isCommentary: true }],
    });
    const fallback = await buildReplyPayloads({
      ...sharedParams,
      payloads: [{ text: "run failed", isError: true }],
    });

    expect(first.replyPayloads[0]?.replyToId).toBe("msg");
    expect(fallback.replyPayloads[0]?.replyToId).toBeUndefined();
  });

  it("records the reply policy used by dedupe and final delivery", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello" }],
      replyToMode: "first",
      originatingChatType: "dm",
    });

    expect(
      getReplyPayloadMetadata(expectDefined(replyPayloads[0], "replyPayloads[0] test invariant"))
        ?.replyDelivery,
    ).toEqual({
      chatType: "direct",
      replyToMode: "first",
    });
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
    expectFields(
      getReplyPayloadMetadata(expectDefined(replyPayloads[0], "replyPayloads[0] test invariant")),
      {
        deliverDespiteSourceReplySuppression: true,
      },
    );
  });

  it("sanitizes source reply transcript mirror text with final payload text", async () => {
    const text = [
      "Visible",
      "<function_response>",
      'Searching for: "what skills matter most in the age of AI"',
      "...",
      "</function_response>",
      "Done",
    ].join("\n");
    const payload = setReplyPayloadMetadata(
      { text },
      {
        sourceReplyTranscriptMirror: {
          sessionKey: "agent:main",
          text,
        },
      },
    );

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [payload],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("Visible\n\nDone");
    expect(
      getReplyPayloadMetadata(expectDefined(replyPayloads[0], "replyPayloads[0] test invariant"))
        ?.sourceReplyTranscriptMirror?.text,
    ).toBe("Visible\n\nDone");
  });

  it("strips media URL from payload when in messagingToolSentMediaUrls", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(
      expectDefined(replyPayloads[0], "replyPayloads[0] test invariant").mediaUrl,
    ).toBeUndefined();
  });

  it("preserves media URL when not in messagingToolSentMediaUrls", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/other.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(expectDefined(replyPayloads[0], "replyPayloads[0] test invariant").mediaUrl).toBe(
      "file:///tmp/photo.jpg",
    );
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
      text: "keep text\n⚠️ Media failed.",
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

  it("does not apply ambiguous global text evidence across multiple routes", async () => {
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

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("hello world!");
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

  it("does not apply ambiguous global media evidence across multiple routes", async () => {
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
      mediaUrl: "file:///tmp/photo.jpg",
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

  it("keeps same-channel final text when the message tool sent it to another thread", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "thread reply" }],
      messageProvider: "slack",
      originatingTo: "channel:C1",
      originatingThreadId: "222.000",
      messagingToolSentTexts: ["thread reply"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          threadId: "111.000",
          text: "thread reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("thread reply");
  });

  it("dedupes a top-level Slack reply that starts the same implicit thread", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "thread reply" }],
      replyToMode: "first",
      replyToChannel: "slack",
      currentMessageId: "111.000",
      messageProvider: "slack",
      originatingTo: "channel:C1",
      messagingToolSentTexts: ["thread reply"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          threadId: "111.000",
          text: "thread reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("dedupes an existing Slack thread by its root instead of the current child message", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "thread reply" }],
      replyToMode: "all",
      replyToChannel: "slack",
      currentMessageId: "111.222",
      messageProvider: "slack",
      originatingTo: "channel:C1",
      originatingThreadId: "111.000",
      messagingToolSentTexts: ["thread reply"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          threadId: "111.000",
          text: "thread reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("keeps an explicit Slack reply when tool evidence only matches the ambient thread", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "thread reply", replyToId: "999.000" }],
      replyToMode: "all",
      replyToChannel: "slack",
      currentMessageId: "111.222",
      messageProvider: "slack",
      originatingTo: "channel:C1",
      originatingThreadId: "111.000",
      messagingToolSentTexts: ["thread reply"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          threadId: "111.000",
          text: "thread reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
  });

  it("dedupes an explicit Slack reply against tool evidence for that reply thread", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "thread reply", replyToId: "999.000", replyToTag: true }],
      replyToMode: "all",
      replyToChannel: "slack",
      currentMessageId: "111.222",
      messageProvider: "slack",
      originatingTo: "channel:C1",
      originatingThreadId: "111.000",
      messagingToolSentTexts: ["thread reply"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          threadId: "999.000",
          text: "thread reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("keeps an unthreaded later Slack payload when only the first payload starts a thread", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "intro" }, { text: "result" }],
      replyToMode: "first",
      replyToChannel: "slack",
      currentMessageId: "111.000",
      messageProvider: "slack",
      originatingTo: "channel:C1",
      messagingToolSentTexts: ["result"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          threadId: "111.000",
          text: "result",
        },
      ],
    });

    expect(replyPayloads.map((payload) => payload.text)).toEqual(["intro", "result"]);
  });

  it("dedupes against final routes when first-reply state is shared", async () => {
    const applyReplyToMode = createReplyToModeFilterForChannel("first", "slack");
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "intro" }, { text: "result" }],
      replyToMode: "first",
      replyToChannel: "slack",
      currentMessageId: "111.000",
      applyReplyToMode,
      messageProvider: "slack",
      originatingTo: "channel:C1",
      messagingToolSentTexts: ["result"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          threadId: "111.000",
          text: "result",
        },
      ],
    });

    expect(replyPayloads.map((payload) => [payload.text, payload.replyToId])).toEqual([
      ["intro", "111.000"],
      ["result", undefined],
    ]);
  });

  it("does not treat a Discord native reply id as a thread route", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "same reply" }],
      replyToMode: "all",
      replyToChannel: "discord",
      currentMessageId: "native-message-1",
      messageProvider: "discord",
      originatingTo: "channel:C1",
      messagingToolSentTexts: ["same reply"],
      messagingToolSentTargets: [
        {
          tool: "discord",
          provider: "discord",
          to: "channel:C1",
          text: "same reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("dedupes an explicit Mattermost DM reply against its top-level delivery route", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "same reply", replyToId: "post-1", replyToTag: true }],
      replyToMode: "off",
      replyToChannel: "mattermost",
      messageProvider: "mattermost",
      originatingChatType: "direct",
      originatingTo: "user:U1",
      messagingToolSentTexts: ["same reply"],
      messagingToolSentTargets: [
        {
          tool: "mattermost",
          provider: "mattermost",
          to: "user:U1",
          text: "same reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("dedupes an implicit Mattermost send in the active thread", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "same reply" }],
      replyToMode: "all",
      replyToChannel: "mattermost",
      currentMessageId: "child-post",
      messageProvider: "mattermost",
      originatingTo: "channel:C1",
      originatingThreadId: "root-post",
      messagingToolSentTexts: ["same reply"],
      messagingToolSentTargets: [
        {
          tool: "mattermost",
          provider: "mattermost",
          to: "channel:C1",
          threadId: "root-post",
          threadImplicit: true,
          text: "same reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("does not dedupe an explicit Mattermost reply to another thread root", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "same reply", replyToId: "other-root", replyToTag: true }],
      replyToMode: "all",
      replyToChannel: "mattermost",
      messageProvider: "mattermost",
      originatingChatType: "channel",
      originatingTo: "channel:C1",
      originatingThreadId: "root-post",
      messagingToolSentTexts: ["same reply"],
      messagingToolSentTargets: [
        {
          tool: "mattermost",
          provider: "mattermost",
          to: "channel:C1",
          threadId: "root-post",
          text: "same reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
  });

  it("dedupes an explicit Mattermost reply to the same thread root", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "same reply", replyToId: "root-post", replyToTag: true }],
      replyToMode: "all",
      replyToChannel: "mattermost",
      messageProvider: "mattermost",
      originatingChatType: "channel",
      originatingTo: "channel:C1",
      originatingThreadId: "ambient-root",
      messagingToolSentTexts: ["same reply"],
      messagingToolSentTargets: [
        {
          tool: "mattermost",
          provider: "mattermost",
          to: "channel:C1",
          threadId: "root-post",
          text: "same reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("dedupes an off-mode explicit Slack reply against its top-level delivery route", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "same reply", replyToId: "111.000", replyToTag: true }],
      replyToMode: "off",
      replyToChannel: "slack",
      messageProvider: "slack",
      originatingTo: "channel:C1",
      messagingToolSentTexts: ["same reply"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          text: "same reply",
        },
      ],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("dedupes an off-mode explicit Slack reply against the ambient thread route", async () => {
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      config: {},
      payloads: [{ text: "same reply", replyToId: "999.000", replyToTag: true }],
      replyToMode: "off",
      replyToChannel: "slack",
      messageProvider: "slack",
      originatingTo: "channel:C1",
      originatingThreadId: "111.000",
      messagingToolSentTexts: ["same reply"],
      messagingToolSentTargets: [
        {
          tool: "slack",
          provider: "slack",
          to: "channel:C1",
          threadId: "111.000",
          text: "same reply",
        },
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

  it("preserves unsent text-only final payloads after block pipeline streamed partial content", async () => {
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
    // The pipeline streamed some partial content, but the final text payload was
    // never sent (hasSentPayload returns false). The old bug dropped all text-only
    // finals unconditionally; the fix preserves unsent finals.
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "all",
      payloads: [{ text: "response", replyToId: "post-123" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("response");
  });

  it("drops already-sent text-only final payloads after block pipeline streamed the exact same text", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: () => true,
      hasSentExactPayload: (payload) =>
        payload.text === "response" && !payload.mediaUrl && !payload.mediaUrls,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      getSentMediaUrls: () => [],
    };
    // The final text-only payload matches what the pipeline already sent,
    // so it should be dropped.
    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      replyToMode: "all",
      payloads: [{ text: "response", replyToId: "post-123" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("drops a text-only final with an empty envelope assembled from multiple streamed blocks", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: () => true,
      hasSentExactPayload: () => false,
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
      payloads: [{ text: "first block second block", channelData: {} }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("preserves final rich content when only its text was streamed", async () => {
    const pipeline: Parameters<typeof buildReplyPayloads>[0]["blockReplyPipeline"] = {
      didStream: () => true,
      isAborted: () => false,
      hasSentPayload: () => true,
      hasSentExactPayload: () => false,
      enqueue: () => {},
      flush: async () => {},
      stop: () => {},
      hasBuffered: () => false,
      getSentMediaUrls: () => [],
    };
    const presentation = {
      blocks: [{ type: "buttons" as const, buttons: [{ label: "Open", value: "open" }] }],
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      payloads: [{ text: "response", presentation }],
    });

    expect(replyPayloads).toEqual([
      expect.objectContaining({
        text: "response",
        presentation,
      }),
    ]);
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

  it("drops final caption and media already sent as one coalesced block payload", async () => {
    const pipeline = createBlockReplyPipeline({
      onBlockReply: async () => {},
      timeoutMs: 5000,
      coalescing: {
        minChars: 1,
        maxChars: 200,
        idleMs: 0,
        joiner: " ",
      },
    });
    pipeline.enqueue({ text: "Preview" });
    pipeline.enqueue({ text: "below" });
    pipeline.enqueue({ mediaUrls: ["file:///photo.png"] });
    await pipeline.flush({ force: true });

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      blockReplyPipeline: pipeline,
      payloads: [{ text: "Preview below", mediaUrls: ["file:///photo.png"] }],
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

  it("surfaces a warning when non-silent media payloads fail normalization", async () => {
    const normalizeMediaPaths = async () => {
      throw new Error("file not found");
    };

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      payloads: [{ text: "MEDIA: ./missing.png" }],
      normalizeMediaPaths,
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "⚠️ Media failed.",
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    });
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

  it("keeps only final media when the text was sent as a direct block", async () => {
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>([
      createBlockReplyContentKey({ text: "response" }),
    ]);

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      directlySentBlockKeys,
      directlySentBlockPayloads: [{ text: "response" }],
      payloads: [{ text: "response\n\nMEDIA:/tmp/generated.png" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: undefined,
      mediaUrl: "/tmp/generated.png",
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("keeps only final media after a direct block without a streaming pipeline", async () => {
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>([
      createBlockReplyContentKey({ text: "response" }),
    ]);

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      directlySentBlockKeys,
      directlySentBlockPayloads: [{ text: "response" }],
      payloads: [{ text: "response\n\nMEDIA:/tmp/generated.png" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: undefined,
      mediaUrl: "/tmp/generated.png",
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("keeps unmatched text finals when unrelated direct blocks were sent", async () => {
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>([
      createBlockReplyContentKey({ mediaUrl: "/tmp/other.png" }),
    ]);

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      directlySentBlockKeys,
      payloads: [{ text: "new final response" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], { text: "new final response" });
  });

  it("keeps only final media after multiple direct text blocks", async () => {
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>([
      createBlockReplyContentKey({ text: "Preview" }),
      createBlockReplyContentKey({ text: " below" }),
    ]);

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      directlySentBlockKeys,
      directlySentBlockPayloads: [{ text: "Preview" }, { text: " below" }],
      payloads: [{ text: "Preview below\n\nMEDIA:/tmp/generated.png" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: undefined,
      mediaUrl: "/tmp/generated.png",
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("keeps only final media after repeated identical direct text blocks", async () => {
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>([createBlockReplyContentKey({ text: "ha" })]);

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      directlySentBlockKeys,
      directlySentBlockPayloads: [{ text: "ha" }, { text: "ha" }],
      payloads: [{ text: "haha\n\nMEDIA:/tmp/generated.png" }],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: undefined,
      mediaUrl: "/tmp/generated.png",
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("preserves final text when internal whitespace changed", async () => {
    const directlySentBlockPayloads = [
      setReplyPayloadMetadata({ text: "constx=1" }, { assistantMessageIndex: 1 }),
    ];
    const finalPayload = setReplyPayloadMetadata(
      { text: "const x = 1\n\nMEDIA:/tmp/generated.png" },
      { assistantMessageIndex: 1 },
    );

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      directlySentBlockPayloads,
      payloads: [finalPayload],
    });

    expectFields(replyPayloads[0], {
      text: "const x = 1",
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("keeps only media not already sent with a direct block", async () => {
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>([
      createBlockReplyContentKey({ text: "response", mediaUrl: "/tmp/already.png" }),
    ]);

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      directlySentBlockKeys,
      directlySentBlockPayloads: [{ text: "response", mediaUrl: "/tmp/already.png" }],
      payloads: [
        {
          text: "response",
          mediaUrls: ["/tmp/already.png", "/tmp/new.png"],
        },
      ],
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: undefined,
      mediaUrl: undefined,
      mediaUrls: ["/tmp/new.png"],
    });
  });

  it("ignores direct status notices when matching final text", async () => {
    const { createBlockReplyContentKey } = await import("./block-reply-pipeline.js");
    const directlySentBlockKeys = new Set<string>([
      createBlockReplyContentKey({ text: "Compacting", isStatusNotice: true }),
      createBlockReplyContentKey({ text: "response" }),
    ]);

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      directlySentBlockKeys,
      directlySentBlockPayloads: [{ text: "response" }],
      payloads: [{ text: "response\n\nMEDIA:/tmp/generated.png" }],
    });

    expectFields(replyPayloads[0], {
      text: undefined,
      mediaUrls: ["/tmp/generated.png"],
    });
  });

  it("matches direct fragments within each assistant message", async () => {
    const firstDirect = setReplyPayloadMetadata({ text: "alpha" }, { assistantMessageIndex: 1 });
    const secondDirect = setReplyPayloadMetadata({ text: "beta" }, { assistantMessageIndex: 2 });
    const firstFinal = setReplyPayloadMetadata(
      { text: "alpha\n\nMEDIA:/tmp/a.png" },
      { assistantMessageIndex: 1 },
    );
    const secondFinal = setReplyPayloadMetadata(
      { text: "beta\n\nMEDIA:/tmp/b.png" },
      { assistantMessageIndex: 2 },
    );

    const { replyPayloads } = await buildReplyPayloads({
      ...baseParams,
      blockStreamingEnabled: true,
      directlySentBlockPayloads: [firstDirect, secondDirect],
      payloads: [firstFinal, secondFinal],
    });

    expect(replyPayloads.map((payload) => payload.text)).toEqual([undefined, undefined]);
    expect(replyPayloads.map((payload) => payload.mediaUrls)).toEqual([
      ["/tmp/a.png"],
      ["/tmp/b.png"],
    ]);
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

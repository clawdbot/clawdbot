// Tests reply payload construction and metadata propagation from agent runs.

import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "../../agents/embedded-agent-runner/run/payloads.js";
import type { ChannelThreadingAdapter } from "../../channels/plugins/types.public.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../../plugins/runtime.js";
import {
  sanitizeAssistantVisibleText,
  stripAssistantInternalScaffolding,
} from "../../shared/text/assistant-visible-text.js";
import {
  createChannelTestPluginBase,
  createTestRegistry,
} from "../../test-utils/channel-plugins.js";
import {
  createHeartbeatToolResponsePayload,
  resolveHeartbeatScratchProposalFromReplyResult,
  resolveHeartbeatToolResponseFromReplyResult,
} from "../heartbeat-tool-response.js";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
  setReplyPayloadMetadata,
} from "../reply-payload.js";
import type { ReplyPayload } from "../types.js";
import { buildReplyPayloads } from "./agent-runner-payloads.js";
import { createBlockReplyContentKey, createBlockReplyPipeline } from "./block-reply-pipeline.js";
import { normalizeReplyPayload } from "./normalize-reply.js";
import { createReplyToModeFilterForChannel } from "./reply-threading.js";

const baseParams = {
  isHeartbeat: false,
  didLogHeartbeatStrip: false,
  blockStreamingEnabled: false,
  blockReplyPipeline: null,
  replyToMode: "off" as const,
};

type TestReplyPayloadParams = Partial<Parameters<typeof buildReplyPayloads>[0]> &
  Pick<Parameters<typeof buildReplyPayloads>[0], "payloads">;

type ReplyRouteDedupeCase = {
  name: string;
  channel: "slack" | "discord" | "mattermost";
  text: string;
  payload?: Record<string, unknown>;
  payloads?: TestReplyPayloadParams["payloads"];
  params: Partial<TestReplyPayloadParams>;
  target: Record<string, unknown>;
  to?: string;
  sharedFirstReply?: boolean;
  expected: string[];
  expectedReplyIds?: Array<string | undefined>;
};

type DirectBlockDedupeCase = {
  name: string;
  keyPayloads: Array<Parameters<typeof createBlockReplyContentKey>[0]>;
  payloads: TestReplyPayloadParams["payloads"];
  directlySentBlockPayloads?: TestReplyPayloadParams["directlySentBlockPayloads"];
  params?: Partial<TestReplyPayloadParams>;
  expected?: Record<string, unknown>;
};

function buildTestReplyPayloads(overrides: TestReplyPayloadParams) {
  return buildReplyPayloads({ ...baseParams, ...overrides });
}

describe("heartbeat reply scratch", () => {
  it.each([
    { proposals: ["private replacement"], expected: "private replacement" },
    { proposals: ["old proposal", "new proposal"], expected: "new proposal" },
    { proposals: ["old proposal", undefined], expected: undefined },
  ])(
    "preserves the latest decision through final reply construction: $proposals",
    async ({ proposals, expected }) => {
      const response = { outcome: "done" as const, notify: false, summary: "Monitor checked." };
      const { replyPayloads } = await buildTestReplyPayloads({
        isHeartbeat: true,
        payloads: proposals.map((scratch) =>
          createHeartbeatToolResponsePayload({ ...response, scratch }),
        ),
      });

      expect(resolveHeartbeatScratchProposalFromReplyResult(replyPayloads)).toBe(expected);
      expect(resolveHeartbeatToolResponseFromReplyResult(replyPayloads)).toEqual(response);
      for (const scratch of proposals) {
        if (scratch !== undefined) {
          expect(JSON.stringify(replyPayloads)).not.toContain(scratch);
        }
      }
    },
  );
});

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
  const { replyPayloads } = await buildTestReplyPayloads({
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
                replyToIsExplicit,
                replyDelivery,
              }: ResolveReplyTransportParams) => {
                const allowedReply = replyDelivery?.replyToMode === "off" ? undefined : replyToId;
                // Slack uses the known root for inherited replies, but explicit targets win.
                const resolved =
                  replyToIsExplicit === false
                    ? (threadId ?? allowedReply)
                    : (allowedReply ?? threadId);
                return {
                  replyToId: resolved == null ? undefined : String(resolved),
                  threadId: null,
                };
              },
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
                const isFlatDirect =
                  replyDelivery?.chatType === "direct" && replyDelivery.replyToMode === "off";
                const resolvedThreadId = isFlatDirect
                  ? undefined
                  : replyDelivery
                    ? replyToIsExplicit
                      ? (replyToId ?? ambientThreadId)
                      : (ambientThreadId ?? replyToId ?? undefined)
                    : (ambientThreadId ?? replyToId);
                return {
                  replyToId: isFlatDirect ? null : resolvedThreadId,
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

  it("redacts copied inbound context before XML and metadata mutate its exact bytes", async () => {
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "[Telegram] Alice: private history",
      "",
      "[Current message - respond to this]",
      '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
      "private inbound paragraph",
    ].join("\n");

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: `${conversationContext}\n\nVisible answer.` }],
      conversationContext,
    });

    expect(replyPayloads).toEqual([expect.objectContaining({ text: "Visible answer." })]);
  });

  it.each<{
    name: string;
    payload: ReplyPayload;
    sentMediaUrls?: string[];
    expected?: ReplyPayload[];
  }>([
    {
      name: "unsent media after the legacy media URL was already sent",
      payload: {
        text: "already sent",
        mediaUrl: "file:///tmp/sent.ogg",
        mediaUrls: ["file:///tmp/unsent-a.ogg", "file:///tmp/unsent-b.ogg"],
        audioAsVoice: true,
      },
      sentMediaUrls: ["file:///tmp/sent.ogg"],
      expected: [
        {
          text: "already sent",
          mediaUrl: undefined,
          mediaUrls: ["file:///tmp/unsent-a.ogg", "file:///tmp/unsent-b.ogg"],
          audioAsVoice: true,
        },
      ],
    },
    {
      name: "an unsent portable presentation",
      payload: {
        text: "already sent",
        presentation: {
          blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
        },
      },
    },
    {
      name: "unsent legacy interactive controls",
      payload: {
        text: "already sent",
        interactive: {
          blocks: [{ type: "buttons", buttons: [{ label: "Retry", value: "retry" }] }],
        },
      },
    },
    {
      name: "unsent channel-specific content",
      payload: { text: "already sent", channelData: { telegram: { buttons: [] } } },
    },
    {
      name: "an unsent portable location",
      payload: { text: "already sent", location: { latitude: 1, longitude: 2 } },
    },
    {
      name: "an enabled delivery operation",
      payload: { text: "already sent", delivery: { pin: true } },
    },
    {
      name: "an enabled configured delivery operation",
      payload: { text: "already sent", delivery: { pin: { enabled: true } } },
    },
    {
      name: "no unsent content for a disabled delivery operation",
      payload: { text: "already sent", delivery: { pin: { enabled: false } } },
      expected: [],
    },
  ])("preserves $name when only the reply text was sent", async (testCase) => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [testCase.payload],
      messagingToolSentTexts: ["already sent"],
      messagingToolSentMediaUrls: testCase.sentMediaUrls,
    });

    const expected = testCase.expected ?? [testCase.payload];
    expect(replyPayloads).toHaveLength(expected.length);
    for (const [index, payload] of expected.entries()) {
      expect(replyPayloads[index]).toMatchObject(payload);
    }
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
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [payload],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(replyPayloads[0]?.text).toBe("Visible\n\nDone");
    expect(
      getReplyPayloadMetadata(expectDefined(replyPayloads[0], "replyPayloads[0] test invariant"))
        ?.sourceReplyTranscriptMirror?.text,
    ).toBe("Visible\n\nDone");
  });

  it("redacts copied inbound context from the visible reply and its transcript mirror", async () => {
    const conversationContext = [
      "[Chat messages since your last reply - for context]",
      "Alice: private history",
      "",
      "[Current message - respond to this]",
      '<function_calls><invoke name="exec">private XML</invoke></function_calls>',
      "private inbound paragraph",
    ].join("\n");
    const text = `${conversationContext}\n\nVisible answer.`;
    const payload = setReplyPayloadMetadata(
      { text },
      { sourceReplyTranscriptMirror: { sessionKey: "agent:main", text } },
    );

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [payload],
      conversationContext,
    });

    expect(replyPayloads[0]?.text).toBe("Visible answer.");
    expect(
      getReplyPayloadMetadata(expectDefined(replyPayloads[0], "expected prepared reply payload"))
        ?.sourceReplyTranscriptMirror?.text,
    ).toBe("Visible answer.");
  });

  it("strips media URL from payload when in messagingToolSentMediaUrls", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "hello", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    expect(replyPayloads).toHaveLength(1);
    expect(
      expectDefined(replyPayloads[0], "replyPayloads[0] test invariant").mediaUrl,
    ).toBeUndefined();
  });

  it("preserves media URL when not in messagingToolSentMediaUrls", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
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
    const normalizeMediaPaths = async (payload: ReplyPayload) => {
      if (payload.mediaUrl === "./bad.png") {
        return setReplyPayloadMetadata(
          {
            ...payload,
            text: "keep text\n⚠️ bad.png: Delivery failed. Try sending this file again.",
            mediaUrl: undefined,
            mediaUrls: undefined,
            audioAsVoice: false,
          },
          {
            assistantMediaFailures: [
              {
                code: "delivery-failed",
                kind: "image",
                label: "bad.png",
                mimeType: "image/png",
              },
            ],
          },
        );
      }
      return payload;
    };

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [
        { text: "keep text", mediaUrl: "./bad.png", audioAsVoice: true },
        { text: "keep second" },
      ],
      normalizeMediaPaths,
    });

    expect(replyPayloads).toHaveLength(2);
    expectFields(replyPayloads[0], {
      text: "keep text\n⚠️ bad.png: Delivery failed. Try sending this file again.",
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    });
    expectFields(replyPayloads[1], {
      text: "keep second",
    });
  });

  it("drops duplicate caption text after matching media is stripped", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "hello world!", mediaUrl: "file:///tmp/photo.jpg" }],
      messagingToolSentTexts: ["hello world!"],
      messagingToolSentMediaUrls: ["file:///tmp/photo.jpg"],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("keeps captioned media when only the caption matches a messaging tool send", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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

  it.each<ReplyRouteDedupeCase>([
    {
      name: "keeps same-channel final text when the message tool sent it to another thread",
      channel: "slack",
      text: "thread reply",
      params: { originatingThreadId: "222.000" },
      target: { threadId: "111.000" },
      expected: ["thread reply"],
    },
    {
      name: "dedupes a top-level Slack reply that starts the same implicit thread",
      channel: "slack",
      text: "thread reply",
      params: { replyToMode: "first", currentMessageId: "111.000" },
      target: { threadId: "111.000" },
      expected: [],
    },
    {
      name: "dedupes an existing Slack thread by its root instead of the current child message",
      channel: "slack",
      text: "thread reply",
      params: {
        replyToMode: "all",
        currentMessageId: "111.222",
        originatingThreadId: "111.000",
      },
      target: { threadId: "111.000" },
      expected: [],
    },
    {
      name: "keeps an explicit Slack reply when tool evidence only matches the ambient thread",
      channel: "slack",
      text: "thread reply",
      payload: { replyToId: "999.000" },
      params: {
        replyToMode: "all",
        currentMessageId: "111.222",
        originatingThreadId: "111.000",
      },
      target: { threadId: "111.000" },
      expected: ["thread reply"],
    },
    {
      name: "dedupes an explicit Slack reply against tool evidence for that reply thread",
      channel: "slack",
      text: "thread reply",
      payload: { replyToId: "999.000", replyToTag: true },
      params: {
        replyToMode: "all",
        currentMessageId: "111.222",
        originatingThreadId: "111.000",
      },
      target: { threadId: "999.000" },
      expected: [],
    },
    {
      name: "keeps an unthreaded later Slack payload when only the first payload starts a thread",
      channel: "slack",
      text: "result",
      payloads: [{ text: "intro" }, { text: "result" }],
      params: { replyToMode: "first", currentMessageId: "111.000" },
      target: { threadId: "111.000" },
      expected: ["intro", "result"],
    },
    {
      name: "dedupes against final routes when first-reply state is shared",
      channel: "slack",
      text: "result",
      payloads: [{ text: "intro" }, { text: "result" }],
      params: { replyToMode: "first", currentMessageId: "111.000" },
      target: { threadId: "111.000" },
      sharedFirstReply: true,
      expected: ["intro", "result"],
      expectedReplyIds: ["111.000", undefined],
    },
    {
      name: "does not treat a Discord native reply id as a thread route",
      channel: "discord",
      text: "same reply",
      params: { replyToMode: "all", currentMessageId: "native-message-1" },
      target: {},
      expected: [],
    },
    {
      name: "dedupes an explicit Mattermost DM reply against its top-level delivery route",
      channel: "mattermost",
      text: "same reply",
      payload: { replyToId: "post-1", replyToTag: true },
      params: { replyToMode: "off", originatingChatType: "direct" },
      to: "user:U1",
      target: {},
      expected: [],
    },
    {
      name: "dedupes an all-mode Mattermost DM reply against the same thread",
      channel: "mattermost",
      text: "same reply",
      payload: { replyToId: "post-1", replyToTag: true },
      params: { replyToMode: "all", originatingChatType: "direct" },
      to: "user:U1",
      target: { threadId: "post-1" },
      expected: [],
    },
    {
      name: "keeps an all-mode Mattermost DM reply when the tool sent it top-level",
      channel: "mattermost",
      text: "same reply",
      payload: { replyToId: "post-1", replyToTag: true },
      params: { replyToMode: "all", originatingChatType: "direct" },
      to: "user:U1",
      target: {},
      expected: ["same reply"],
    },
    {
      name: "dedupes an implicit Mattermost send in the active thread",
      channel: "mattermost",
      text: "same reply",
      params: {
        replyToMode: "all",
        currentMessageId: "child-post",
        originatingThreadId: "root-post",
      },
      target: { threadId: "root-post", threadImplicit: true },
      expected: [],
    },
    {
      name: "does not dedupe an explicit Mattermost reply to another thread root",
      channel: "mattermost",
      text: "same reply",
      payload: { replyToId: "other-root", replyToTag: true },
      params: {
        replyToMode: "all",
        originatingChatType: "channel",
        originatingThreadId: "root-post",
      },
      target: { threadId: "root-post" },
      expected: ["same reply"],
    },
    {
      name: "dedupes an explicit Mattermost reply to the same thread root",
      channel: "mattermost",
      text: "same reply",
      payload: { replyToId: "root-post", replyToTag: true },
      params: {
        replyToMode: "all",
        originatingChatType: "channel",
        originatingThreadId: "ambient-root",
      },
      target: { threadId: "root-post" },
      expected: [],
    },
    {
      name: "dedupes an off-mode explicit Slack reply against its top-level delivery route",
      channel: "slack",
      text: "same reply",
      payload: { replyToId: "111.000", replyToTag: true },
      params: { replyToMode: "off" },
      target: {},
      expected: [],
    },
    {
      name: "dedupes an off-mode explicit Slack reply against the ambient thread route",
      channel: "slack",
      text: "same reply",
      payload: { replyToId: "999.000", replyToTag: true },
      params: { replyToMode: "off", originatingThreadId: "111.000" },
      target: { threadId: "111.000" },
      expected: [],
    },
  ])("$name", async (testCase) => {
    const { channel, text, params, target } = testCase;
    const to = testCase.to ?? "channel:C1";
    const { replyPayloads } = await buildTestReplyPayloads({
      config: {},
      payloads: testCase.payloads ?? [{ text, ...testCase.payload }],
      replyToChannel: channel,
      messageProvider: channel,
      originatingTo: to,
      messagingToolSentTexts: [text],
      messagingToolSentTargets: [{ tool: channel, provider: channel, to, text, ...target }],
      ...params,
      ...(testCase.sharedFirstReply
        ? { applyReplyToMode: createReplyToModeFilterForChannel("first", channel) }
        : {}),
    });

    expect(replyPayloads.map((payload) => payload.text)).toEqual(testCase.expected);
    if (testCase.expectedReplyIds) {
      expect(replyPayloads.map((payload) => payload.replyToId)).toEqual(testCase.expectedReplyIds);
    }
  });

  it("does not dedupe short commentary that appears inside a longer same-target message", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
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

    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
      silentExpected: true,
      payloads: [{ text: "NO_REPLY", mediaUrl: "file:///tmp/photo.jpg" }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("keeps error payloads during silent turns", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
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

  it.each(["exec", "bash"])(
    "delivers the real %s failure warning after a silent answer",
    async (toolName) => {
      const payloads = buildEmbeddedRunPayloads({
        assistantTexts: ["NO_REPLY"],
        lastAssistant: undefined,
        lastToolError: { toolName, error: "Command not found" },
        sessionKey: "agent:main:warning",
      });
      const { replyPayloads } = await buildTestReplyPayloads({ payloads });
      const delivered = replyPayloads
        .map((payload) => normalizeReplyPayload(payload))
        .filter(Boolean);

      expect(delivered).toEqual([
        expect.objectContaining({
          text: `⚠️ ${toolName === "exec" ? "Exec" : "Bash"} failed`,
          isError: true,
        }),
      ]);
      // Both channel text cleanup and Control UI display must retain the warning.
      expect(sanitizeAssistantVisibleText(delivered[0]?.text ?? "")).toBe(delivered[0]?.text);
      expect(stripAssistantInternalScaffolding(delivered[0]?.text ?? "")).toBe(delivered[0]?.text);
      expect(
        normalizeReplyPayload({
          text: `⚠️ 🛠️ ${toolName === "exec" ? "Exec" : "Bash"} failed`,
          isError: true,
        }),
      ).toBeNull();
    },
  );

  it("keeps voice media payloads during silent turns", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
      silentExpected: true,
      payloads: [{ audioAsVoice: true }],
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("suppresses warning text when silent media payloads fail normalization", async () => {
    const normalizeMediaPaths = async (payload: ReplyPayload) => ({
      ...payload,
      text: "⚠️ missing.png: File not found. Check the path and try again.",
      mediaUrl: undefined,
      mediaUrls: undefined,
    });

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "NO_REPLY\nMEDIA: ./missing.png" }],
      normalizeMediaPaths,
    });

    expect(replyPayloads).toHaveLength(0);
  });

  it("surfaces a named receipt when non-silent media payloads fail normalization", async () => {
    const normalizeMediaPaths = async (payload: ReplyPayload) => ({
      ...payload,
      text: "⚠️ missing.png: File not found. Check the path and try again.",
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    });

    const { replyPayloads } = await buildTestReplyPayloads({
      payloads: [{ text: "MEDIA: ./missing.png" }],
      normalizeMediaPaths,
    });

    expect(replyPayloads).toHaveLength(1);
    expectFields(replyPayloads[0], {
      text: "⚠️ missing.png: File not found. Check the path and try again.",
      mediaUrl: undefined,
      mediaUrls: undefined,
      audioAsVoice: false,
    });
  });

  it("extracts markdown image replies into final payload media urls", async () => {
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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

  it.each<DirectBlockDedupeCase>([
    {
      name: "deduplicates final payloads against directly sent block keys regardless of replyToId",
      keyPayloads: [{ text: "response", replyToId: "post-1" }],
      payloads: [{ text: "response" }],
      params: { blockStreamingEnabled: false, blockReplyPipeline: null, replyToMode: "off" },
    },
    {
      name: "deduplicates final payloads against directly sent block keys when streaming is enabled without a pipeline",
      keyPayloads: [{ text: "response", replyToId: "post-1" }],
      payloads: [{ text: "response" }],
      params: { blockStreamingEnabled: true, blockReplyPipeline: null, replyToMode: "off" },
    },
    {
      name: "keeps only final media when the text was sent as a direct block",
      keyPayloads: [{ text: "response" }],
      directlySentBlockPayloads: [{ text: "response" }],
      payloads: [{ text: "response\n\nMEDIA:/tmp/generated.png" }],
      expected: {
        text: undefined,
        mediaUrl: "/tmp/generated.png",
        mediaUrls: ["/tmp/generated.png"],
      },
    },
    {
      name: "keeps only final media after a direct block without a streaming pipeline",
      keyPayloads: [{ text: "response" }],
      directlySentBlockPayloads: [{ text: "response" }],
      payloads: [{ text: "response\n\nMEDIA:/tmp/generated.png" }],
      params: { blockStreamingEnabled: true },
      expected: {
        text: undefined,
        mediaUrl: "/tmp/generated.png",
        mediaUrls: ["/tmp/generated.png"],
      },
    },
    {
      name: "keeps unmatched text finals when unrelated direct blocks were sent",
      keyPayloads: [{ mediaUrl: "/tmp/other.png" }],
      payloads: [{ text: "new final response" }],
      params: { blockStreamingEnabled: true },
      expected: { text: "new final response" },
    },
    {
      name: "keeps only final media after multiple direct text blocks",
      keyPayloads: [{ text: "Preview" }, { text: " below" }],
      directlySentBlockPayloads: [{ text: "Preview" }, { text: " below" }],
      payloads: [{ text: "Preview below\n\nMEDIA:/tmp/generated.png" }],
      params: { blockStreamingEnabled: true },
      expected: {
        text: undefined,
        mediaUrl: "/tmp/generated.png",
        mediaUrls: ["/tmp/generated.png"],
      },
    },
    {
      name: "keeps only final media after repeated identical direct text blocks",
      keyPayloads: [{ text: "ha" }],
      directlySentBlockPayloads: [{ text: "ha" }, { text: "ha" }],
      payloads: [{ text: "haha\n\nMEDIA:/tmp/generated.png" }],
      params: { blockStreamingEnabled: true },
      expected: {
        text: undefined,
        mediaUrl: "/tmp/generated.png",
        mediaUrls: ["/tmp/generated.png"],
      },
    },
    {
      name: "keeps only media not already sent with a direct block",
      keyPayloads: [{ text: "response", mediaUrl: "/tmp/already.png" }],
      directlySentBlockPayloads: [{ text: "response", mediaUrl: "/tmp/already.png" }],
      payloads: [{ text: "response", mediaUrls: ["/tmp/already.png", "/tmp/new.png"] }],
      params: { blockStreamingEnabled: true },
      expected: { text: undefined, mediaUrl: undefined, mediaUrls: ["/tmp/new.png"] },
    },
    {
      name: "ignores direct status notices when matching final text",
      keyPayloads: [{ text: "Compacting", isStatusNotice: true }, { text: "response" }],
      directlySentBlockPayloads: [{ text: "response" }],
      payloads: [{ text: "response\n\nMEDIA:/tmp/generated.png" }],
      params: { blockStreamingEnabled: true },
      expected: { text: undefined, mediaUrls: ["/tmp/generated.png"] },
    },
  ])("$name", async ({ keyPayloads, payloads, directlySentBlockPayloads, params, expected }) => {
    const { replyPayloads } = await buildTestReplyPayloads({
      directlySentBlockKeys: new Set(keyPayloads.map(createBlockReplyContentKey)),
      ...(directlySentBlockPayloads ? { directlySentBlockPayloads } : {}),
      payloads,
      ...params,
    });

    expect(replyPayloads).toHaveLength(expected ? 1 : 0);
    if (expected) {
      expectFields(replyPayloads[0], expected);
    }
  });

  it("preserves final text when internal whitespace changed", async () => {
    const directlySentBlockPayloads = [
      setReplyPayloadMetadata({ text: "constx=1" }, { assistantMessageIndex: 1 }),
    ];
    const finalPayload = setReplyPayloadMetadata(
      { text: "const x = 1\n\nMEDIA:/tmp/generated.png" },
      { assistantMessageIndex: 1 },
    );

    const { replyPayloads } = await buildTestReplyPayloads({
      blockStreamingEnabled: true,
      directlySentBlockPayloads,
      payloads: [finalPayload],
    });

    expectFields(replyPayloads[0], {
      text: "const x = 1",
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

    const { replyPayloads } = await buildTestReplyPayloads({
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
    const { replyPayloads } = await buildTestReplyPayloads({
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

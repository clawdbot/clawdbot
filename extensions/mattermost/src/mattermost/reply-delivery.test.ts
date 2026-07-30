// Mattermost tests cover reply delivery plugin behavior.
import path from "node:path";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import {
  createMattermostReplyDeliveryBarrier,
  deliverMattermostReplyPayload,
} from "./reply-delivery.js";
import type { MattermostSendResult } from "./send.js";

type DeliverMattermostReplyPayloadParams = Parameters<typeof deliverMattermostReplyPayload>[0];
type ReplyDeliveryMarkdownTableMode = Parameters<
  DeliverMattermostReplyPayloadParams["core"]["channel"]["text"]["convertMarkdownTables"]
>[1];

function createReplyDeliveryCore(): DeliverMattermostReplyPayloadParams["core"] {
  return {
    channel: {
      text: {
        chunkByNewline: vi.fn((text: string) => [text]),
        chunkMarkdownText: vi.fn((text: string) => [text]),
        convertMarkdownTables: vi.fn((text: string) => text),
        chunkText: vi.fn((text: string) => [text]),
        chunkTextWithMode: vi.fn((text: string) => [text]),
        resolveMarkdownTableMode: vi.fn<() => ReplyDeliveryMarkdownTableMode>(() => "off"),
        resolveChunkMode: vi.fn<() => ChunkMode>(() => "length"),
        resolveTextChunkLimit: vi.fn(
          (
            _cfg?: OpenClawConfig,
            _provider?: string,
            _accountId?: string | null,
            opts?: { fallbackLimit?: number },
          ) => opts?.fallbackLimit ?? 4000,
        ),
        hasControlCommand: vi.fn(() => false),
        chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
      },
    },
  } as unknown as PluginRuntime;
}

function createSendMessageMock() {
  let sendCount = 0;
  return vi.fn(async (_to: string, content: string): Promise<MattermostSendResult> => {
    const messageId = `post-${++sendCount}`;
    return {
      messageId,
      channelId: "channel-1",
      content: content.trim(),
      receipt: createMessageReceiptFromOutboundResults({
        results: [{ channel: "mattermost", messageId, channelId: "channel-1" }],
        kind: "text",
      }),
    };
  });
}

describe("createMattermostReplyDeliveryBarrier", () => {
  it("extends while direct deliveries or DM resolution remain unsettled", async () => {
    const barrier = createMattermostReplyDeliveryBarrier({ isDirect: true });
    const policy = barrier.resolveTimeoutPolicy({
      queuedCounts: { tool: 1, block: 0, final: 1 },
      humanDelayBudgetMs: 0,
    });
    expect(policy?.maxTimeoutMs).toBe(420_000);
    expect(policy?.shouldExtend()).toBe(true);

    let resolveResolution: () => void = () => {};
    const resolution = new Promise<void>((resolve) => {
      resolveResolution = resolve;
    });
    barrier.trackDmChannelResolution(resolution);
    expect(policy?.shouldExtend()).toBe(true);

    resolveResolution();
    await resolution;
    await Promise.resolve();
    expect(policy?.shouldExtend()).toBe(true);

    barrier.markDeliverySettled();
    expect(policy?.shouldExtend()).toBe(true);

    barrier.markDeliverySettled();
    expect(policy?.shouldExtend()).toBe(false);
  });

  it("stays extended between failed retries until queued deliveries settle", async () => {
    const barrier = createMattermostReplyDeliveryBarrier({ isDirect: true });
    const policy = barrier.resolveTimeoutPolicy({
      queuedCounts: { tool: 1, block: 0, final: 1 },
      humanDelayBudgetMs: 0,
    });
    let rejectResolution: (error: Error) => void = () => {};
    const resolution = new Promise<void>((_resolve, reject) => {
      rejectResolution = reject;
    });
    barrier.trackDmChannelResolution(resolution);

    rejectResolution(new Error("DM creation failed"));
    await expect(resolution).rejects.toThrow("DM creation failed");
    await Promise.resolve();
    barrier.markDeliverySettled();
    expect(policy?.shouldExtend()).toBe(true);

    barrier.markDeliverySettled();
    expect(policy?.shouldExtend()).toBe(false);
  });

  it("does not extend non-DM delivery", () => {
    const barrier = createMattermostReplyDeliveryBarrier({ isDirect: false });
    expect(
      barrier.resolveTimeoutPolicy({
        queuedCounts: { tool: 1, block: 1, final: 1 },
        humanDelayBudgetMs: 0,
      }),
    ).toBeUndefined();
  });
});

describe("deliverMattermostReplyPayload", () => {
  it("suppresses payloads flagged as reasoning", async () => {
    const sendMessage = createSendMessageMock();
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    const outcome = await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "hidden", isReasoning: true },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      outcome: "reasoning_skipped",
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
  });

  it("returns 'empty' for substantive text that produced no send (regression: #80501)", async () => {
    const sendMessage = createSendMessageMock();
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();
    // Make the markdown table converter strip the text to empty so
    // deliverTextOrMediaReply sees an empty chunked text and returns "empty".
    core.channel.text.convertMarkdownTables = vi.fn(() => "");
    core.channel.text.chunkMarkdownTextWithMode = vi.fn(() => []);

    const outcome = await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "non-trivial input that the converter strips" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      outcome: "empty",
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
  });

  it("suppresses reasoning-prefixed payloads even without an explicit flag", async () => {
    const sendMessage = createSendMessageMock();
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "  \n Reasoning:\n_hidden_" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("suppresses reasoning payloads formatted as a Mattermost blockquote", async () => {
    const sendMessage = createSendMessageMock();
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "> Reasoning:\n> _hidden_" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("does not suppress messages that mention Reasoning: mid-text", async () => {
    const sendMessage = createSendMessageMock();
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "Intro line\nReasoning: appears in content but is not a prefix" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "channel:town-square",
      "Intro line\nReasoning: appears in content but is not a prefix",
      expect.objectContaining({
        cfg,
        accountId: "default",
        replyToId: "root-post",
      }),
    );
  });

  it("passes agent-scoped mediaLocalRoots when sending media paths", async () => {
    const openClawState = await createOpenClawTestState({
      layout: "state-only",
      prefix: "openclaw-mm-state-",
    });
    const stateDir = openClawState.stateDir;

    try {
      const sendMessage = createSendMessageMock();
      const core = createReplyDeliveryCore();

      const agentId = "agent-1";
      const mediaUrl = `file://${path.join(stateDir, `workspace-${agentId}`, "photo.png")}`;
      const cfg = {} satisfies OpenClawConfig;

      await deliverMattermostReplyPayload({
        core,
        cfg,
        payload: { text: "caption", mediaUrl },
        to: "channel:town-square",
        accountId: "default",
        agentId,
        replyToId: "root-post",
        textLimit: 4000,
        tableMode: "off",
        sendMessage,
      });

      expect(sendMessage).toHaveBeenCalledTimes(1);
      expect(sendMessage).toHaveBeenCalledWith(
        "channel:town-square",
        "caption",
        expect.objectContaining({
          cfg,
          accountId: "default",
          mediaUrl,
          replyToId: "root-post",
          mediaLocalRoots: expect.arrayContaining([
            path.join(stateDir, "media"),
            path.join(stateDir, "canvas"),
            path.join(stateDir, "workspace"),
            path.join(stateDir, "sandboxes"),
            path.join(stateDir, `workspace-${agentId}`),
          ]),
        }),
      );
    } finally {
      await openClawState.cleanup();
    }
  });

  it("forwards replyToId for text-only chunked replies", async () => {
    const sendMessage = createSendMessageMock();
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();
    core.channel.text.chunkMarkdownTextWithMode = vi.fn(() => ["hello"]);

    const outcome = await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "hello" },
      to: "channel:town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "channel:town-square",
      "hello",
      expect.objectContaining({
        cfg,
        accountId: "default",
        replyToId: "root-post",
      }),
    );
    expect(outcome).toMatchObject({
      outcome: "text",
      messageIds: ["post-1"],
      visibleReplySent: true,
      content: "hello",
    });
    expect(outcome.receipt?.primaryPlatformMessageId).toBe("post-1");
  });

  it("aggregates every provider post behind one chunked logical payload", async () => {
    const sendMessage = createSendMessageMock();
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();
    core.channel.text.chunkMarkdownTextWithMode = vi.fn(() => ["alpha", "beta"]);

    const result = await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "alpha beta" },
      to: "channel:town-square",
      accountId: "default",
      replyToId: "root-post",
      textLimit: 6,
      tableMode: "off",
      sendMessage,
    });

    expect(result).toMatchObject({
      outcome: "text",
      messageIds: ["post-1", "post-2"],
      visibleReplySent: true,
      content: "alpha\nbeta",
    });
    expect(result.receipt?.parts.map((part) => part.platformMessageId)).toEqual([
      "post-1",
      "post-2",
    ]);
  });

  it("returns provider-finalized visible content instead of the requested text", async () => {
    const sendMessage = vi.fn(
      async (): Promise<MattermostSendResult> => ({
        messageId: "post-final",
        channelId: "channel-1",
        content: "provider-finalized",
        receipt: createMessageReceiptFromOutboundResults({
          results: [{ channel: "mattermost", messageId: "post-final", channelId: "channel-1" }],
          kind: "text",
        }),
      }),
    );

    const result = await deliverMattermostReplyPayload({
      core: createReplyDeliveryCore(),
      cfg: {},
      payload: { text: "requested text" },
      to: "channel:town-square",
      accountId: "default",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(result).toMatchObject({
      messageIds: ["post-final"],
      visibleReplySent: true,
      content: "provider-finalized",
    });
  });

  it("preserves the accepted post when a later chunk fails", async () => {
    const firstResult = createSendMessageMock();
    const sendMessage = vi
      .fn<DeliverMattermostReplyPayloadParams["sendMessage"]>()
      .mockImplementationOnce(firstResult)
      .mockRejectedValueOnce(new Error("second chunk failed"));
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();
    core.channel.text.chunkMarkdownTextWithMode = vi.fn(() => ["alpha", "beta"]);

    let caught: unknown;
    try {
      await deliverMattermostReplyPayload({
        core,
        cfg,
        payload: { text: "alpha beta" },
        to: "channel:town-square",
        accountId: "default",
        replyToId: "root-post",
        textLimit: 6,
        tableMode: "off",
        sendMessage,
      });
    } catch (error: unknown) {
      caught = error;
    }

    expect(isChannelPartialDeliveryError(caught)).toBe(true);
    if (!isChannelPartialDeliveryError(caught)) {
      throw new Error("expected a partial Mattermost delivery error");
    }
    expect(caught.deliveryResult).toMatchObject({
      messageIds: ["post-1"],
      visibleReplySent: true,
      content: "alpha",
    });
  });
});

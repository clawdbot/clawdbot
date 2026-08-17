// Mattermost tests cover reply delivery plugin behavior.
import path from "node:path";
import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import type { ChunkMode } from "openclaw/plugin-sdk/reply-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig, PluginRuntime } from "../../runtime-api.js";
import { deliverMattermostReplyPayload } from "./reply-delivery.js";
import type { MattermostSendResult } from "./send.js";

type DeliverMattermostReplyPayloadParams = Parameters<typeof deliverMattermostReplyPayload>[0];
type SendMattermostMessageOptions = Parameters<
  DeliverMattermostReplyPayloadParams["sendMessage"]
>[2];
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
  return vi.fn(
    async (
      _to: string,
      content: string,
      _opts: SendMattermostMessageOptions,
    ): Promise<MattermostSendResult> => {
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
    },
  );
}

describe("deliverMattermostReplyPayload", () => {
  it("suppresses payloads flagged as reasoning", async () => {
    const sendMessage = createSendMessageMock();
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    const outcome = await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "hidden", isReasoning: true },
      channelId: "town-square",
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
      channelId: "town-square",
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
      channelId: "town-square",
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
      channelId: "town-square",
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
      channelId: "town-square",
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
        channelId: "town-square",
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
          // Local (non-http) media must require a successful upload so a
          // failure surfaces instead of silently posting the caption alone.
          requireMediaUpload: true,
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

  it("does not require upload for remote (http) media captions", async () => {
    const sendMessage = createSendMessageMock();
    const cfg = {} satisfies OpenClawConfig;
    const core = createReplyDeliveryCore();

    await deliverMattermostReplyPayload({
      core,
      cfg,
      payload: { text: "caption", mediaUrl: "https://example.com/photo.png" },
      channelId: "town-square",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const options = sendMessage.mock.calls[0]?.[2] as { requireMediaUpload?: boolean };
    expect(options.requireMediaUpload).toBeUndefined();
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
      channelId: "channel-1",
      accountId: "default",
      agentId: "agent-1",
      replyToId: "root-post",
      textLimit: 4000,
      tableMode: "off",
      sendMessage,
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "channel:channel-1",
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
      channelId: "town-square",
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
      channelId: "town-square",
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
        channelId: "town-square",
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

// Matrix tests cover replies plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime, RuntimeEnv } from "../../../runtime-api.js";
import type { MatrixClient } from "../sdk.js";

const sendMessageMatrixMock = vi.hoisted(() => vi.fn());

vi.mock("../send.js", () => ({
  sendMessageMatrix: (to: string, message: string, opts?: unknown) =>
    sendMessageMatrixMock(to, message, opts),
}));

import { setMatrixRuntime } from "../../runtime.js";
import { deliverMatrixReplies } from "./replies.js";

let nextMessageId = 0;

async function resolveMockMatrixSend(_to: string, message: string, opts?: Record<string, unknown>) {
  nextMessageId += 1;
  const messageId = `mx-${nextMessageId}`;
  const mediaUrl = typeof opts?.mediaUrl === "string" ? opts.mediaUrl : "unknown";
  const content = message || `media:${mediaUrl}`;
  const result = {
    messageId,
    roomId: "room:1",
    primaryMessageId: messageId,
    receipt: {
      primaryPlatformMessageId: messageId,
      platformMessageIds: [messageId],
      parts: [{ platformMessageId: messageId, kind: "text" as const, index: 0 }],
      sentAt: 1,
    },
    content,
  };
  const onDeliveryResult = opts?.onDeliveryResult;
  if (typeof onDeliveryResult === "function") {
    await onDeliveryResult(result);
  }
  return result;
}

function sendCall(index: number) {
  const call = sendMessageMatrixMock.mock.calls.at(index);
  if (!call) {
    throw new Error(`Expected send call at index ${index}`);
  }
  return call;
}

function sendOptions(index: number): Record<string, unknown> {
  const options = sendCall(index)[2];
  if (!options || typeof options !== "object") {
    throw new Error(`Expected send options at call ${index}`);
  }
  return options as Record<string, unknown>;
}

describe("deliverMatrixReplies", () => {
  const cfg = { channels: { matrix: {} } };
  const loadConfigMock = vi.fn(() => ({}));
  const resolveMarkdownTableModeMock = vi.fn<(params: unknown) => string>(() => "code");
  const convertMarkdownTablesMock = vi.fn((text: string) => text);
  const resolveChunkModeMock = vi.fn<
    (cfg: unknown, channel: unknown, accountId?: unknown) => string
  >(() => "length");
  const chunkMarkdownTextWithModeMock = vi.fn((text: string) => [text]);

  const runtimeStub = {
    config: {
      current: () => loadConfigMock(),
    },
    channel: {
      text: {
        resolveMarkdownTableMode: (params: unknown) => resolveMarkdownTableModeMock(params),
        resolveTextChunkLimit: () => 4000,
        convertMarkdownTables: (text: string) => convertMarkdownTablesMock(text),
        resolveChunkMode: (cfgLocal: unknown, channel: unknown, accountId?: unknown) =>
          resolveChunkModeMock(cfgLocal, channel, accountId),
        chunkMarkdownTextWithMode: (text: string) => chunkMarkdownTextWithModeMock(text),
      },
    },
    logging: {
      shouldLogVerbose: () => false,
    },
  } as unknown as PluginRuntime;

  const runtimeEnv: RuntimeEnv = {
    log: vi.fn(),
    error: vi.fn(),
  } as unknown as RuntimeEnv;

  beforeEach(() => {
    vi.clearAllMocks();
    nextMessageId = 0;
    sendMessageMatrixMock.mockReset().mockImplementation(resolveMockMatrixSend);
    setMatrixRuntime(runtimeStub);
  });

  const offModeReplyCases: Array<{
    name: string;
    reply: Parameters<typeof deliverMatrixReplies>[0]["replies"][number];
    expectedReplyToId?: string;
    threadId?: string;
  }> = [
    {
      name: "an explicit reply tag",
      reply: { text: "hello", replyToId: "$chosen", replyToTag: true },
      expectedReplyToId: "$chosen",
    },
    {
      name: "an explicit current-message reply",
      reply: { text: "hello", replyToId: "$chosen", replyToCurrent: true },
      expectedReplyToId: "$chosen",
    },
    {
      name: "an implicit payload reply",
      reply: { text: "hello", replyToId: "$implicit" },
    },
    {
      name: "an ambient implicit reply",
      reply: { text: "hello" },
    },
    {
      name: "a status notice whose explicit reply was stripped upstream",
      reply: { text: "hello", replyToCurrent: true, isCompactionNotice: true },
    },
    {
      name: "a thread's ambient fallback reply",
      reply: { text: "hello" },
      expectedReplyToId: "$ambient",
      threadId: "$thread",
    },
  ];

  it.each(offModeReplyCases)(
    "encodes the actual Matrix provider reply relation for $name when replyToMode=off",
    async ({ reply, expectedReplyToId, threadId }) => {
      const actualSend = await vi.importActual<typeof import("../send.js")>("../send.js");
      sendMessageMatrixMock.mockImplementation(actualSend.sendMessageMatrix);
      const sendMessage = vi.fn(
        async (_roomId: string, _content: Record<string, unknown>) => "$sent",
      );
      const client = {
        sendMessage,
        prepareRoomForMessageSend: async () => "m.room.message",
        getJoinedRoomMembers: async () => [],
        getUserId: async () => "@bot:example.org",
      } as unknown as MatrixClient;

      const result = await deliverMatrixReplies({
        cfg,
        replies: [reply],
        roomId: "!room:example.org",
        client,
        runtime: runtimeEnv,
        replyToMode: "off",
        replyToId: "$ambient",
        threadId,
      });

      expect(result.visibleReplySent).toBe(true);
      expect(sendMessage).toHaveBeenCalledOnce();
      const content = sendMessage.mock.calls[0]?.[1];
      const relation = content?.["m.relates_to"] as
        | { "m.in_reply_to"?: { event_id?: string }; event_id?: string }
        | undefined;
      expect(relation?.["m.in_reply_to"]?.event_id).toBe(expectedReplyToId);
      if (threadId) {
        expect(relation?.event_id).toBe(threadId);
      }
    },
  );

  it.each(["first", "off"] as const)(
    "preserves explicit replies after shared reply state is consumed when replyToMode=%s",
    async (replyToMode) => {
      const hasRepliedRef = { value: false };
      const delivery = {
        cfg,
        roomId: "room:1",
        client: {} as MatrixClient,
        runtime: runtimeEnv,
        replyToMode,
        replyToId: "ambient-reply",
        hasRepliedRef,
      };

      await deliverMatrixReplies({
        ...delivery,
        replies: [
          {
            text: "consume implicit slot",
            replyToId: "first-reply",
            ...(replyToMode === "off" ? { replyToTag: true } : {}),
          },
        ],
      });
      await deliverMatrixReplies({
        ...delivery,
        replies: [{ text: "explicit tag", replyToId: "tag-reply", replyToTag: true }],
      });
      await deliverMatrixReplies({
        ...delivery,
        replies: [{ text: "explicit current", replyToId: "current-reply", replyToCurrent: true }],
      });
      await deliverMatrixReplies({ ...delivery, replies: [{ text: "implicit follow-up" }] });

      expect(hasRepliedRef.value).toBe(true);
      expect(sendMessageMatrixMock).toHaveBeenCalledTimes(4);
      expect(sendOptions(0).replyToId).toBe("first-reply");
      expect(sendOptions(1).replyToId).toBe("tag-reply");
      expect(sendOptions(2).replyToId).toBe("current-reply");
      expect(sendOptions(3).replyToId).toBeUndefined();
    },
  );

  it("does not consume the first reply when Matrix delivery fails", async () => {
    const hasRepliedRef = { value: false };
    const delivery = {
      cfg,
      replies: [{ text: "retry me" }],
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "first" as const,
      replyToId: "reply-1",
      hasRepliedRef,
    };
    sendMessageMatrixMock.mockRejectedValueOnce(new Error("Matrix unavailable"));

    await expect(deliverMatrixReplies(delivery)).rejects.toThrow("Matrix unavailable");
    expect(hasRepliedRef.value).toBe(false);

    await expect(deliverMatrixReplies(delivery)).resolves.toMatchObject({
      visibleReplySent: true,
    });
    expect(sendOptions(0).replyToId).toBe("reply-1");
    expect(sendOptions(1).replyToId).toBe("reply-1");
    expect(hasRepliedRef.value).toBe(true);
  });

  it("returns an explicit non-visible result when every reply is suppressed", async () => {
    const result = await deliverMatrixReplies({
      cfg,
      replies: [{ text: "<think>hidden</think>" }],
      roomId: "room:1",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(result).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
  });

  it("preserves native thread fallback after the first reply has been consumed", async () => {
    const hasRepliedRef = { value: true };

    await deliverMatrixReplies({
      cfg,
      replies: [{ text: "thread follow-up" }],
      roomId: "room:3",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "first",
      replyToId: "reply-thread",
      threadId: "thread-77",
      hasRepliedRef,
    });

    expect(sendOptions(0).replyToId).toBe("reply-thread");
    expect(sendOptions(0).threadId).toBe("thread-77");
  });

  it("keeps replyToId on every reply when replyToMode=all", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        {
          text: "caption",
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          replyToId: "reply-media",
          audioAsVoice: true,
        },
        { text: "plain", replyToId: "reply-text" },
      ],
      roomId: "room:2",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "all",
      mediaLocalRoots: ["/tmp/openclaw-matrix-test"],
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(3);
    expect(sendCall(0)[0]).toBe("room:2");
    expect(sendCall(0)[1]).toBe("caption");
    expect(sendOptions(0).mediaUrl).toBe("https://example.com/a.jpg");
    expect(sendOptions(0).mediaLocalRoots).toEqual(["/tmp/openclaw-matrix-test"]);
    expect(sendOptions(0).replyToId).toBe("reply-media");
    expect(sendCall(1)[0]).toBe("room:2");
    expect(sendCall(1)[1]).toBe("");
    expect(sendOptions(1).mediaUrl).toBe("https://example.com/b.jpg");
    expect(sendOptions(1).mediaLocalRoots).toEqual(["/tmp/openclaw-matrix-test"]);
    expect(sendOptions(1).replyToId).toBe("reply-media");
    expect(sendOptions(2).replyToId).toBe("reply-text");
  });

  it("uses singular media when plural media entries are blank", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        {
          text: "caption",
          mediaUrl: "https://example.com/fallback.jpg",
          mediaUrls: ["   "],
        },
      ],
      roomId: "room:2",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(sendOptions(0).mediaUrl).toBe("https://example.com/fallback.jpg");
  });

  it("reports blank-only media as missing instead of silently suppressing it", async () => {
    const result = await deliverMatrixReplies({
      cfg,
      replies: [{ mediaUrls: ["   "] }],
      roomId: "room:2",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(runtimeEnv.error).toHaveBeenCalledWith("matrix reply missing text/media");
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
  });

  it("reports blank text with blank-only media as missing", async () => {
    const result = await deliverMatrixReplies({
      cfg,
      replies: [{ text: "   ", mediaUrls: ["   "] }],
      roomId: "room:2",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(runtimeEnv.error).toHaveBeenCalledWith("matrix reply missing text/media");
    expect(sendMessageMatrixMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      visibleReplySent: false,
      suppression: { reason: "no_visible_result" },
    });
  });

  it("suppresses reasoning-only text before Matrix sends", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        { text: "Reasoning:\n_hidden_" },
        { text: "<think>still hidden</think>" },
        { text: "<mm:think>MiniMax private reasoning</mm:think>" },
        { text: "<mm:thought>MiniMax private thought</mm:thought>" },
        { text: "<antml:thinking>Anthropic private reasoning</antml:thinking>" },
        { text: "Visible answer" },
      ],
      roomId: "room:5",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[0]).toBe("room:5");
    expect(sendCall(0)[1]).toBe("Visible answer");
    expect(sendOptions(0).cfg).toBe(cfg);
  });

  it("delivers literal reasoning tags inside Markdown code", async () => {
    const text = "Use `<mm:think>example</mm:think>` literally.";

    await deliverMatrixReplies({
      cfg,
      replies: [{ text }],
      roomId: "room:5",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[1]).toBe(text);
  });

  it("strips namespaced reasoning while delivering visible Matrix replies", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        { text: "<mm:think>MiniMax private reasoning</mm:think>Visible MiniMax answer" },
        { text: "<antml:thinking>Anthropic private reasoning</antml:thinking>Visible answer" },
        { text: "<br>Visible HTML answer<mm:think>MiniMax private reasoning</mm:think>" },
        { text: "Visible safe answer<mm:think>unfinished private reasoning" },
        { text: "Visible answer<think>old reasoning</think><think>unfinished private reasoning" },
        { text: "<thinking>private reasoning</think>Visible alias answer" },
        { text: "<final>Visible final answer" },
      ],
      roomId: "room:5",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(7);
    expect(sendCall(0)[1]).toBe("Visible MiniMax answer");
    expect(sendCall(1)[1]).toBe("Visible answer");
    expect(sendCall(2)[1]).toBe("<br>Visible HTML answer");
    expect(sendCall(3)[1]).toBe("Visible safe answer");
    expect(sendCall(4)[1]).toBe("Visible answer");
    expect(sendCall(5)[1]).toBe("Visible alias answer");
    expect(sendCall(6)[1]).toBe("Visible final answer");
  });

  it("delivers Matrix media without a reasoning-only caption", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        {
          text: "<mm:think>MiniMax private reasoning</mm:think>",
          mediaUrl: "https://example.com/a.jpg",
        },
      ],
      roomId: "room:5",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(1);
    expect(sendCall(0)[1]).toBe("");
    expect(sendOptions(0).mediaUrl).toBe("https://example.com/a.jpg");
  });

  it("uses supplied cfg for send delivery without reloading runtime config", async () => {
    const explicitCfg = {
      channels: {
        matrix: {
          accounts: {
            ops: {
              chunkMode: "newline",
            },
          },
        },
      },
    };
    loadConfigMock.mockImplementation(() => {
      throw new Error("deliverMatrixReplies should not reload runtime config when cfg is provided");
    });

    await deliverMatrixReplies({
      cfg: explicitCfg,
      replies: [{ text: "hello", replyToId: "reply-1" }],
      roomId: "room:4",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "all",
      accountId: "ops",
    });

    expect(loadConfigMock).not.toHaveBeenCalled();
    expect(sendCall(0)[0]).toBe("room:4");
    expect(sendCall(0)[1]).toBe("hello");
    expect(sendOptions(0).cfg).toBe(explicitCfg);
    expect(sendOptions(0).accountId).toBe("ops");
    expect(sendOptions(0).replyToId).toBe("reply-1");
  });

  it("passes raw media captions through to sendMessageMatrix without pre-converting them", async () => {
    convertMarkdownTablesMock.mockImplementation((text: string) => `converted:${text}`);

    await deliverMatrixReplies({
      cfg,
      replies: [{ text: "caption", mediaUrl: "https://example.com/a.jpg" }],
      roomId: "room:6",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(sendCall(0)[0]).toBe("room:6");
    expect(sendCall(0)[1]).toBe("caption");
    expect(sendOptions(0).mediaUrl).toBe("https://example.com/a.jpg");
  });

  it("renders presentation metadata for direct Matrix replies", async () => {
    const presentation = {
      title: "Environment",
      blocks: [
        {
          type: "select" as const,
          placeholder: "Environment",
          options: [
            {
              label: "Production",
              action: { type: "command" as const, command: "/deploy production" },
            },
          ],
        },
      ],
    };

    await deliverMatrixReplies({
      cfg,
      replies: [{ text: "Choose", presentation }],
      roomId: "room:7",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(sendCall(0)[1]).toContain("Production");
    expect(sendCall(0)[1]).toContain("/deploy production");
    expect(sendCall(0)[1]).not.toBe("Choose");
    expect(sendOptions(0).extraContent).toEqual({
      "com.openclaw.presentation": {
        ...presentation,
        version: 1,
        type: "message.presentation",
      },
    });
  });

  it("does not drop controls-only Matrix replies", async () => {
    const presentation = {
      blocks: [
        {
          type: "buttons" as const,
          buttons: [{ label: "Deploy", action: { type: "command" as const, command: "/deploy" } }],
        },
      ],
    };

    const result = await deliverMatrixReplies({
      cfg,
      replies: [{ presentation }],
      roomId: "room:8",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(result.visibleReplySent).toBe(true);
    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(String(sendCall(0)[1]).trim()).not.toBe("");
    expect(runtimeEnv.error).not.toHaveBeenCalledWith("matrix reply missing text/media");
    expect(sendOptions(0).extraContent).toMatchObject({
      "com.openclaw.presentation": {
        version: 1,
        type: "message.presentation",
      },
    });
  });

  it("preserves authored fallback when Matrix drops unsupported data blocks", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        {
          text: "Authored table fallback",
          presentationTextMode: "fallback",
          presentation: {
            title: "Status",
            blocks: [
              {
                type: "table",
                caption: "Session status",
                headers: ["Item", "Value"],
                rows: [["Model", "example/model"]],
              },
            ],
          },
        },
      ],
      roomId: "room:9",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(sendCall(0)[1]).toBe("Authored table fallback");
    expect(sendOptions(0).extraContent).toBeUndefined();
  });

  it("keeps supported metadata beside authored fallback data blocks", async () => {
    await deliverMatrixReplies({
      cfg,
      replies: [
        {
          text: "Authored table fallback",
          presentationTextMode: "fallback",
          presentation: {
            title: "Status",
            blocks: [
              {
                type: "table",
                caption: "Session status",
                headers: ["Item", "Value"],
                rows: [["Model", "example/model"]],
              },
              { type: "context", text: "Updated 1m ago" },
            ],
          },
        },
      ],
      roomId: "room:9",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledOnce();
    expect(sendCall(0)[1]).toBe("Authored table fallback");
    expect(sendOptions(0).extraContent).toMatchObject({
      "com.openclaw.presentation": {
        version: 1,
        type: "message.presentation",
        blocks: expect.arrayContaining([{ type: "context", text: "Updated 1m ago" }]),
      },
    });
  });

  it("attaches presentation metadata only to the first Matrix media event", async () => {
    const presentation = {
      title: "Environment",
      blocks: [
        {
          type: "select" as const,
          options: [{ label: "Production", value: "/deploy production" }],
        },
      ],
    };

    await deliverMatrixReplies({
      cfg,
      replies: [
        {
          text: "Choose",
          mediaUrls: ["https://example.com/a.jpg", "https://example.com/b.jpg"],
          presentation,
        },
      ],
      roomId: "room:9",
      client: {} as MatrixClient,
      runtime: runtimeEnv,
      replyToMode: "off",
    });

    expect(sendMessageMatrixMock).toHaveBeenCalledTimes(2);
    expect(sendOptions(0).extraContent).toMatchObject({
      "com.openclaw.presentation": {
        version: 1,
        type: "message.presentation",
        title: "Environment",
      },
    });
    expect(sendOptions(1).extraContent).toBeUndefined();
  });
});

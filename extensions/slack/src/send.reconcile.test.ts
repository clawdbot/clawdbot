import { expectDefined } from "@openclaw/normalization-core";
// Slack tests cover exact delivery-queue reconciliation through message metadata.
import type { MessageMetadata } from "@slack/types";
import type { ChatPostMessageArguments, WebClient } from "@slack/web-api";
import type { ChannelMessageUnknownSendContext } from "openclaw/plugin-sdk/channel-outbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileSlackUnknownSend, sendMessageSlack } from "./send.js";

const slackClientMocks = vi.hoisted(() => ({
  createSlackWebClient: vi.fn(),
  getSlackWriteClient: vi.fn(),
}));

vi.mock("./client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./client.js")>();
  return {
    ...actual,
    createSlackWebClient: slackClientMocks.createSlackWebClient,
    getSlackWriteClient: slackClientMocks.getSlackWriteClient,
  };
});

type SlackReconcileTestClient = WebClient & {
  chat: {
    postMessage: ReturnType<
      typeof vi.fn<(request: ChatPostMessageArguments) => Promise<Record<string, unknown>>>
    >;
  };
  conversations: {
    history: ReturnType<
      typeof vi.fn<(request: Record<string, unknown>) => Promise<Record<string, unknown>>>
    >;
    open: ReturnType<
      typeof vi.fn<(request: Record<string, unknown>) => Promise<Record<string, unknown>>>
    >;
    replies: ReturnType<
      typeof vi.fn<(request: Record<string, unknown>) => Promise<Record<string, unknown>>>
    >;
  };
};

const cfg = {
  channels: {
    slack: {
      botToken: "xoxb-test",
    },
  },
} as OpenClawConfig;

function createSlackReconcileTestClient(): SlackReconcileTestClient {
  return {
    chat: {
      postMessage: vi.fn(async () => ({
        ok: true,
        channel: "C123",
        ts: "1782584647.000002",
        message: {},
      })),
    },
    conversations: {
      history: vi.fn(async () => ({ messages: [] })),
      open: vi.fn(async () => ({ channel: { id: "D123" } })),
      replies: vi.fn(async () => ({ messages: [] })),
    },
  } as unknown as SlackReconcileTestClient;
}

function createUnknownSendContext(
  overrides: Partial<ChannelMessageUnknownSendContext> = {},
): ChannelMessageUnknownSendContext {
  return {
    cfg,
    queueId: "queue-1",
    channel: "slack",
    to: "channel:C123",
    enqueuedAt: 1_782_584_644_000,
    retryCount: 0,
    platformSendStartedAt: 1_782_584_645_000,
    payloads: [{ text: "final answer" }],
    ...overrides,
  };
}

async function postWithDeliveryMetadata(params: {
  client: SlackReconcileTestClient;
  queueId?: string;
  metadata?: MessageMetadata;
  to?: string;
  threadTs?: string;
}): Promise<MessageMetadata> {
  await sendMessageSlack(params.to ?? "channel:C123", "final answer", {
    cfg,
    client: params.client,
    deliveryQueueId: params.queueId ?? "queue-1",
    metadata: params.metadata,
    threadTs: params.threadTs,
  });
  const request = params.client.chat.postMessage.mock.calls[0]?.[0] as
    | ChatPostMessageArguments
    | undefined;
  expect(request?.metadata).toBeDefined();
  return request?.metadata as MessageMetadata;
}

describe("reconcileSlackUnknownSend", () => {
  beforeEach(() => {
    slackClientMocks.createSlackWebClient.mockReset();
    slackClientMocks.getSlackWriteClient.mockReset();
  });

  it("attaches an opaque durable id and reconciles the exact posted message", async () => {
    const client = createSlackReconcileTestClient();
    const metadata = await postWithDeliveryMetadata({ client });
    expect(JSON.stringify(metadata)).not.toContain("queue-1");
    client.conversations.history.mockResolvedValueOnce({
      messages: [
        { ts: "1782584646.000001", text: "final answer" },
        { ts: "1782584647.000002", text: "mutated by Slack", metadata },
      ],
    });

    const result = await reconcileSlackUnknownSend(createUnknownSendContext(), { client });

    expect(client.conversations.history).toHaveBeenCalledWith({
      channel: "C123",
      oldest: "1782584315.000000",
      latest: "1782584945.000000",
      include_all_metadata: true,
      limit: 100,
    });
    expect(result.status).toBe("sent");
    if (result.status === "sent") {
      expect(result.messageId).toBe("1782584647.000002");
      expect(result.receipt.platformMessageIds).toEqual(["1782584647.000002"]);
    }
  });

  it("attaches a complete single-part marker to successful block sends", async () => {
    const client = createSlackReconcileTestClient();
    const sent = await sendMessageSlack("channel:C123", "Status", {
      cfg,
      client,
      deliveryQueueId: "queue-1",
      blocks: [{ type: "section", text: { type: "mrkdwn", text: "Status" } }],
    });
    const request = client.chat.postMessage.mock.calls[0]?.[0] as ChatPostMessageArguments;
    const metadata = request.metadata as MessageMetadata;

    expect(metadata.event_payload).toMatchObject({
      openclaw_delivery_part_index: 0,
      openclaw_delivery_part_count: 1,
    });
    expect(sent.receipt.platformMessageIds).toEqual(["1782584647.000002"]);
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1782584647.000002", metadata }],
    });

    const reconciled = await reconcileSlackUnknownSend(createUnknownSendContext(), { client });
    expect(reconciled.status).toBe("sent");
    if (reconciled.status === "sent") {
      expect(reconciled.receipt.platformMessageIds).toEqual(["1782584647.000002"]);
    }
  });

  it("reconciles every ordered native-data fallback batch as one durable part set", async () => {
    const client = createSlackReconcileTestClient();
    client.chat.postMessage
      .mockRejectedValueOnce(
        Object.assign(new Error("An API error occurred: invalid_blocks"), {
          data: { error: "invalid_blocks" },
        }),
      )
      .mockResolvedValueOnce({
        ok: true,
        channel: "C123",
        ts: "1782584647.000001",
        message: {},
      })
      .mockResolvedValueOnce({
        ok: true,
        channel: "C123",
        ts: "1782584647.000002",
        message: {},
      });
    const metadata = {
      event_type: "assistant_thread_context",
      event_payload: { team_id: "T123" },
    };
    const sent = await sendMessageSlack("channel:C123", "Pipeline", {
      cfg,
      client,
      deliveryQueueId: "queue-1",
      metadata,
      blocks: [
        ...Array.from({ length: 48 }, () => ({ type: "divider" })),
        {
          type: "actions",
          elements: [
            {
              type: "button",
              action_id: "approve",
              text: { type: "plain_text", text: "Approve" },
              value: "yes",
            },
          ],
        },
        {
          type: "data_table",
          caption: "c".repeat(9_000),
          rows: [[{ type: "raw_text", text: "Account" }], [{ type: "raw_text", text: "Acme" }]],
        },
      ] as never,
    });
    const requests = client.chat.postMessage.mock.calls.map(
      ([request]) => request as ChatPostMessageArguments,
    );
    const rejectedMetadata = requests[0]?.metadata as MessageMetadata;
    const firstFallbackMetadata = requests[1]?.metadata as MessageMetadata;
    const secondFallbackMetadata = requests[2]?.metadata as MessageMetadata;

    expect(rejectedMetadata.event_payload.openclaw_delivery_part_count).toBe(1);
    expect(
      [firstFallbackMetadata, secondFallbackMetadata].map(
        (part) => part.event_payload.openclaw_delivery_part_index,
      ),
    ).toEqual([0, 1]);
    expect(
      [firstFallbackMetadata, secondFallbackMetadata].map(
        (part) => part.event_payload.openclaw_delivery_part_count,
      ),
    ).toEqual([2, 2]);
    expect(firstFallbackMetadata.event_payload).toMatchObject({ team_id: "T123" });
    expect(secondFallbackMetadata.event_payload).not.toHaveProperty("team_id");
    expect(
      new Set(
        [firstFallbackMetadata, secondFallbackMetadata].map(
          (part) => part.event_payload.openclaw_delivery_id,
        ),
      ).size,
    ).toBe(1);
    expect(sent.receipt.platformMessageIds).toEqual(["1782584647.000001", "1782584647.000002"]);
    client.conversations.history.mockResolvedValueOnce({
      messages: [
        { ts: "1782584647.000002", metadata: secondFallbackMetadata },
        { ts: "1782584647.000001", metadata: firstFallbackMetadata },
      ],
    });

    const reconciled = await reconcileSlackUnknownSend(createUnknownSendContext(), { client });
    expect(reconciled.status).toBe("sent");
    if (reconciled.status === "sent") {
      expect(reconciled.receipt.platformMessageIds).toEqual([
        "1782584647.000001",
        "1782584647.000002",
      ]);
    }
  });

  it("refreshes durable timing after dequeue and before Slack API work", async () => {
    const client = createSlackReconcileTestClient();
    const order: string[] = [];
    client.chat.postMessage.mockImplementationOnce(async () => {
      order.push("post");
      return { ok: true, channel: "C123", ts: "1782584647.000002", message: {} };
    });

    await sendMessageSlack("channel:C123", "final answer", {
      cfg,
      client,
      deliveryQueueId: "queue-1",
      onPlatformSendDispatch: async () => {
        order.push("dispatch");
      },
    });

    expect(order).toEqual(["dispatch", "post"]);
  });

  it("resolves a durable DM target before marking platform dispatch", async () => {
    const client = createSlackReconcileTestClient();
    const order: string[] = [];
    client.conversations.open.mockImplementationOnce(async () => {
      order.push("open");
      return { channel: { id: "D123" } };
    });
    client.chat.postMessage.mockImplementationOnce(async () => {
      order.push("post");
      return { ok: true, channel: "D123", ts: "1782584647.000002", message: {} };
    });

    await sendMessageSlack("user:U123", "final answer", {
      cfg,
      client,
      deliveryQueueId: "queue-1",
      onPlatformSendDispatch: async () => {
        order.push("dispatch");
      },
    });

    expect(order).toEqual(["open", "dispatch", "post"]);
  });

  it("preserves existing assistant metadata while adding the durable id", async () => {
    const client = createSlackReconcileTestClient();
    const metadata = await postWithDeliveryMetadata({
      client,
      metadata: {
        event_type: "assistant_thread_context",
        event_payload: { channel_id: "C456", team_id: "T123" },
      },
    });

    expect(metadata.event_type).toBe("assistant_thread_context");
    expect(metadata.event_payload).toMatchObject({ channel_id: "C456", team_id: "T123" });
    expect(metadata.event_payload.openclaw_delivery_id).toEqual(expect.any(String));
  });

  it("reads history with the configured read token", async () => {
    const markerClient = createSlackReconcileTestClient();
    const metadata = await postWithDeliveryMetadata({ client: markerClient });
    const readClient = createSlackReconcileTestClient();
    readClient.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1782584647.000002", metadata }],
    });
    const writeClient = createSlackReconcileTestClient();
    slackClientMocks.createSlackWebClient.mockReturnValue(readClient);
    slackClientMocks.getSlackWriteClient.mockReturnValue(writeClient);
    const tokenCfg = {
      channels: {
        slack: {
          botToken: "xoxb-write",
          userToken: "xoxp-read",
        },
      },
    } as OpenClawConfig;

    await expect(
      reconcileSlackUnknownSend(createUnknownSendContext({ cfg: tokenCfg })),
    ).resolves.toEqual(expect.objectContaining({ status: "sent" }));
    expect(slackClientMocks.createSlackWebClient).toHaveBeenCalledWith("xoxp-read");
    expect(slackClientMocks.getSlackWriteClient).toHaveBeenCalledWith("xoxb-write");
    expect(readClient.conversations.history).toHaveBeenCalledOnce();
    expect(writeClient.conversations.history).not.toHaveBeenCalled();
  });

  it("falls back to the write token when the read token cannot access a bot DM", async () => {
    const markerClient = createSlackReconcileTestClient();
    const metadata = await postWithDeliveryMetadata({ client: markerClient, to: "user:U123" });
    const readClient = createSlackReconcileTestClient();
    readClient.conversations.history.mockRejectedValueOnce(new Error("missing_scope"));
    const writeClient = createSlackReconcileTestClient();
    writeClient.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1782584647.000002", metadata }],
    });
    slackClientMocks.createSlackWebClient.mockReturnValue(readClient);
    slackClientMocks.getSlackWriteClient.mockReturnValue(writeClient);
    const tokenCfg = {
      channels: {
        slack: {
          botToken: "xoxb-write",
          userToken: "xoxp-read",
        },
      },
    } as OpenClawConfig;

    await expect(
      reconcileSlackUnknownSend(createUnknownSendContext({ cfg: tokenCfg, to: "U123" })),
    ).resolves.toEqual(expect.objectContaining({ status: "sent" }));
    expect(writeClient.conversations.open).toHaveBeenCalledWith({ users: "U123" });
    expect(readClient.conversations.history).toHaveBeenCalledOnce();
    expect(writeClient.conversations.history).toHaveBeenCalledOnce();
  });

  it("checks the write token when the read token returns no exact marker", async () => {
    const markerClient = createSlackReconcileTestClient();
    const metadata = await postWithDeliveryMetadata({ client: markerClient });
    const readClient = createSlackReconcileTestClient();
    readClient.conversations.history.mockResolvedValueOnce({ messages: [] });
    const writeClient = createSlackReconcileTestClient();
    writeClient.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1782584647.000002", metadata }],
    });
    slackClientMocks.createSlackWebClient.mockReturnValue(readClient);
    slackClientMocks.getSlackWriteClient.mockReturnValue(writeClient);
    const tokenCfg = {
      channels: {
        slack: {
          botToken: "xoxb-write",
          userToken: "xoxp-read",
        },
      },
    } as OpenClawConfig;

    await expect(
      reconcileSlackUnknownSend(createUnknownSendContext({ cfg: tokenCfg })),
    ).resolves.toEqual(expect.objectContaining({ status: "sent" }));
    expect(readClient.conversations.history).toHaveBeenCalledOnce();
    expect(writeClient.conversations.history).toHaveBeenCalledOnce();
  });

  it("does not confuse an identical later message without the durable id", async () => {
    const client = createSlackReconcileTestClient();
    client.conversations.history.mockResolvedValue({
      messages: [{ ts: "1782584647.000002", text: "final answer" }],
    });

    await expect(
      reconcileSlackUnknownSend(createUnknownSendContext(), { client }),
    ).resolves.toEqual({
      status: "unresolved",
      error: "Slack history contains no exact durable delivery marker",
      retryable: true,
    });
    await expect(
      reconcileSlackUnknownSend(createUnknownSendContext({ retryCount: 2 }), { client }),
    ).resolves.toEqual({
      status: "unresolved",
      error: "Slack history contains no exact durable delivery marker",
      retryable: false,
    });
  });

  it("reconciles an exact thread reply and preserves the parent thread id", async () => {
    const client = createSlackReconcileTestClient();
    const metadata = await postWithDeliveryMetadata({
      client,
      threadTs: "1782584644.377229",
    });
    client.conversations.replies.mockResolvedValueOnce({
      messages: [
        {
          ts: "1782584647.000002",
          thread_ts: "1782584644.377229",
          metadata,
        },
      ],
    });

    const result = await reconcileSlackUnknownSend(
      createUnknownSendContext({
        threadId: "1782584644.111111",
        payloads: [{ text: "final answer", replyToId: "1782584644.222222" }],
        effectiveReplyToId: "1782584644.377229",
      }),
      { client },
    );

    expect(client.conversations.replies).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        ts: "1782584644.377229",
        include_all_metadata: true,
      }),
    );
    expect(result.status).toBe("sent");
    if (result.status === "sent") {
      expect(result.receipt.threadId).toBe("1782584644.377229");
    }
  });

  it.each([
    {
      name: "reply mode disables the ambient reply target",
      overrides: { replyToId: "1782584644.377229", replyToMode: "off" as const },
    },
    {
      name: "an explicit empty payload reply target clears the ambient target",
      overrides: {
        replyToId: "1782584644.377229",
        payloads: [{ text: "final answer", replyToId: "" }],
      },
    },
    {
      name: "the persisted effective target records an intentional root send",
      overrides: {
        replyToId: "1782584644.377229",
        payloads: [{ text: "final answer", replyToId: "1782584644.222222" }],
        effectiveReplyToId: null,
      },
    },
  ])("uses channel history when $name", async ({ overrides }) => {
    const client = createSlackReconcileTestClient();
    const metadata = await postWithDeliveryMetadata({ client });
    client.conversations.history.mockResolvedValueOnce({
      messages: [{ ts: "1782584647.000002", metadata }],
    });

    const result = await reconcileSlackUnknownSend(createUnknownSendContext(overrides), { client });

    expect(result.status).toBe("sent");
    expect(client.conversations.history).toHaveBeenCalledOnce();
    expect(client.conversations.replies).not.toHaveBeenCalled();
  });

  it("paginates history until it finds the exact durable id", async () => {
    const client = createSlackReconcileTestClient();
    const metadata = await postWithDeliveryMetadata({ client });
    client.conversations.history
      .mockResolvedValueOnce({
        messages: [],
        has_more: true,
        response_metadata: { next_cursor: "cursor-2" },
      })
      .mockResolvedValueOnce({
        messages: [{ ts: "1782584647.000002", metadata }],
      });

    await expect(
      reconcileSlackUnknownSend(createUnknownSendContext(), { client }),
    ).resolves.toEqual(expect.objectContaining({ status: "sent", messageId: "1782584647.000002" }));
    expect(client.conversations.history).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ cursor: "cursor-2" }),
    );
  });

  it("reconciles every indexed part of text that Slack splits", async () => {
    const client = createSlackReconcileTestClient();
    const chunkedCfg = {
      channels: { slack: { botToken: "xoxb-test", textChunkLimit: 5 } },
    } as OpenClawConfig;
    let postedPart = 0;
    client.chat.postMessage.mockImplementation(async () => ({
      ok: true,
      channel: "C123",
      ts: `1782584647.00000${++postedPart}`,
      message: {},
    }));

    await sendMessageSlack("channel:C123", "final answer", {
      cfg: chunkedCfg,
      client,
      deliveryQueueId: "queue-1",
    });
    expect(client.chat.postMessage).toHaveBeenCalledTimes(3);
    const postedMetadata = client.chat.postMessage.mock.calls.map(
      ([request]) => (request as ChatPostMessageArguments).metadata as MessageMetadata,
    );
    expect(
      postedMetadata.map((metadata) => metadata.event_payload.openclaw_delivery_part_index),
    ).toEqual([0, 1, 2]);
    expect(
      postedMetadata.map((metadata) => metadata.event_payload.openclaw_delivery_part_count),
    ).toEqual([3, 3, 3]);
    expect(
      new Set(postedMetadata.map((metadata) => metadata.event_payload.openclaw_delivery_id)).size,
    ).toBe(1);
    expect(
      new Set(postedMetadata.map((metadata) => metadata.event_payload.openclaw_delivery_signature))
        .size,
    ).toBe(3);
    client.conversations.history.mockResolvedValueOnce({
      messages: postedMetadata.map((metadata, index) => ({
        ts: `1782584647.00000${index + 1}`,
        metadata,
      })),
    });

    const result = await reconcileSlackUnknownSend(
      createUnknownSendContext({ cfg: chunkedCfg, payloads: [{ text: "final answer" }] }),
      { client },
    );
    expect(result.status).toBe("sent");
    if (result.status === "sent") {
      expect(result.receipt.platformMessageIds).toEqual([
        "1782584647.000001",
        "1782584647.000002",
        "1782584647.000003",
      ]);
    }

    const forgedMetadata: MessageMetadata[] = [];
    const firstMetadata = expectDefined(postedMetadata[0], "first posted Slack metadata");
    for (const partIndex of [1, 2]) {
      forgedMetadata.push({
        ...firstMetadata,
        event_payload: {
          ...firstMetadata.event_payload,
          openclaw_delivery_part_index: partIndex,
        },
      });
    }
    client.conversations.history.mockResolvedValueOnce({
      messages: [
        { ts: "1782584647.000001", metadata: postedMetadata[0] },
        ...forgedMetadata.map((metadata, index) => ({
          ts: `1782584647.00001${index + 1}`,
          metadata,
        })),
      ],
    });
    await expect(
      reconcileSlackUnknownSend(
        createUnknownSendContext({ cfg: chunkedCfg, payloads: [{ text: "final answer" }] }),
        { client },
      ),
    ).resolves.toEqual({
      status: "unresolved",
      error: "Slack history contains an incomplete durable delivery marker set",
      retryable: true,
    });
  });
});

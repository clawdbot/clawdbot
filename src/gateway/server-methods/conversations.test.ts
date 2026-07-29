import { describe, expect, it, vi } from "vitest";
import {
  ConversationInputError,
  ConversationOperationConflictError,
} from "../conversation-errors.js";
import type { runGatewayConversationList } from "../conversation-list.js";
import type { runGatewayConversationSend } from "../conversation-send.js";
import type { runGatewayConversationTurn } from "../conversation-turn.js";
import { createConversationHandlers } from "./conversations.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";

const request = {
  agentId: "main",
  sourceSessionKey: "agent:main:telegram:direct:operator",
  turnId: "conversation-turn-1",
  conversationRef: "conv_0123456789abcdef0123456789abcdef",
  message: "hello molty",
  timeoutMs: 30_000,
};

const result = {
  status: "replied" as const,
  conversationRef: request.conversationRef,
  channel: "reef",
  messageId: "reef-outbound-1",
  correlationPersisted: true,
  reply: {
    conversationRef: request.conversationRef,
    messageId: "reef-inbound-1",
    replyToId: "reef-outbound-1",
    text: "hello clawd",
    timestamp: 300,
  },
};

const sendRequest = {
  agentId: "main",
  sourceSessionKey: "agent:main:telegram:direct:operator",
  operationId: "conversation-send-1",
  conversationRef: request.conversationRef,
  message: "hello molty",
};

const sendResult = {
  status: "sent" as const,
  conversationRef: request.conversationRef,
  channel: "reef",
  messageId: "reef-outbound-1",
  queueId: "conversation-send-1",
};

const adminClient = {
  connect: { scopes: ["operator.admin"] },
} as never;

function context(): GatewayRequestContext {
  return {
    dedupe: new Map(),
    getRuntimeConfig: () => ({}),
  } as GatewayRequestContext;
}

function invoke(params: {
  handler: NonNullable<ReturnType<typeof createConversationHandlers>["conversations.turn"]>;
  context: GatewayRequestContext;
  respond: RespondFn;
  request?: Record<string, unknown>;
}) {
  return params.handler({
    params: params.request ?? request,
    respond: params.respond,
    context: params.context,
    req: { type: "req", id: "1", method: "conversations.turn" },
    client: adminClient,
    isWebchatConnect: () => false,
  });
}

function invokeSend(params: {
  handler: NonNullable<ReturnType<typeof createConversationHandlers>["conversations.send"]>;
  context: GatewayRequestContext;
  respond: RespondFn;
  request?: Record<string, unknown>;
}) {
  return params.handler({
    params: params.request ?? sendRequest,
    respond: params.respond,
    context: params.context,
    req: { type: "req", id: "send-1", method: "conversations.send" },
    client: adminClient,
    isWebchatConnect: () => false,
  });
}

function invokeList(params: {
  handler: NonNullable<ReturnType<typeof createConversationHandlers>["conversations.list"]>;
  context: GatewayRequestContext;
  respond: RespondFn;
  request?: Record<string, unknown>;
}) {
  return params.handler({
    params: params.request ?? { agentId: "main", channel: "reef", query: "@molty", limit: 50 },
    respond: params.respond,
    context: params.context,
    req: { type: "req", id: "list-1", method: "conversations.list" },
    client: adminClient,
    isWebchatConnect: () => false,
  });
}

describe("conversations.list Gateway handler", () => {
  it("runs discovery and listing inside the Gateway runtime", async () => {
    const listed = {
      conversations: [
        {
          conversationRef: request.conversationRef,
          channel: "reef",
          accountId: "default",
          kind: "direct" as const,
          target: "reef:molty",
          firstSeenAt: 100,
          lastSeenAt: 100,
        },
      ],
    };
    const runConversationList = vi.fn(
      async (_params: Parameters<typeof runGatewayConversationList>[0]) => listed,
    );
    const handler = createConversationHandlers({ runConversationList })["conversations.list"]!;
    const respond = vi.fn<RespondFn>();

    await invokeList({ handler, context: context(), respond });

    expect(runConversationList).toHaveBeenCalledWith({
      config: {},
      agentId: "main",
      channel: "reef",
      query: "@molty",
      limit: 50,
    });
    expect(respond).toHaveBeenCalledWith(true, listed, undefined);
  });

  it("rejects invalid limits before directory discovery", async () => {
    const runConversationList = vi.fn();
    const handler = createConversationHandlers({ runConversationList })["conversations.list"]!;
    const respond = vi.fn<RespondFn>();

    await invokeList({
      handler,
      context: context(),
      respond,
      request: { agentId: "main", channel: "reef", limit: 101 },
    });

    expect(runConversationList).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});

describe("conversations.send Gateway handler", () => {
  it("owns the send and rejects operation-id reuse with different source input", async () => {
    const runConversationSend = vi.fn(async () => sendResult);
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationSend,
      runConversationTurn: vi.fn(),
    })["conversations.send"]!;
    const gatewayContext = context();
    const respond = vi.fn<RespondFn>();

    await invokeSend({ handler, context: gatewayContext, respond });
    expect(runConversationSend).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "main",
        senderIsOwner: true,
        sourceSessionKey: "agent:main:telegram:direct:operator",
        operationId: "conversation-send-1",
        conversationRef: request.conversationRef,
        message: "hello molty",
      }),
    );
    expect(respond).toHaveBeenCalledWith(true, sendResult, undefined, { channel: "reef" });

    const mismatchRespond = vi.fn<RespondFn>();
    await invokeSend({
      handler,
      context: gatewayContext,
      respond: mismatchRespond,
      request: { ...sendRequest, sourceSessionKey: "agent:main:discord:channel:other" },
    });
    expect(runConversationSend).toHaveBeenCalledOnce();
    expect(mismatchRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps concurrent operation IDs isolated between agents", async () => {
    let finishMain: ((value: typeof sendResult) => void) | undefined;
    const otherResult = { ...sendResult, messageId: "reef-outbound-other" };
    const runConversationSend = vi.fn(
      async ({ agentId }: Parameters<typeof runGatewayConversationSend>[0]) =>
        agentId === "main"
          ? await new Promise<typeof sendResult>((resolve) => {
              finishMain = resolve;
            })
          : otherResult,
    );
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationSend,
      runConversationTurn: vi.fn(),
    })["conversations.send"]!;
    const gatewayContext = context();
    const mainRespond = vi.fn<RespondFn>();
    const otherRespond = vi.fn<RespondFn>();

    const main = invokeSend({ handler, context: gatewayContext, respond: mainRespond });
    await vi.waitFor(() => expect(runConversationSend).toHaveBeenCalledOnce());
    const other = invokeSend({
      handler,
      context: gatewayContext,
      respond: otherRespond,
      request: { ...sendRequest, agentId: "other-agent" },
    });
    await vi.waitFor(() => expect(runConversationSend).toHaveBeenCalledTimes(2));
    finishMain?.(sendResult);
    await Promise.all([main, other]);

    expect(mainRespond).toHaveBeenCalledWith(true, sendResult, undefined, { channel: "reef" });
    expect(otherRespond).toHaveBeenCalledWith(true, otherResult, undefined, {
      channel: "reef",
    });
  });
});

describe("conversations.turn Gateway handler", () => {
  it("validates requests before entering the correlation service", async () => {
    const runConversationTurn = vi.fn();
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationSend: vi.fn(),
      runConversationTurn,
    })["conversations.turn"]!;
    const respond = vi.fn<RespondFn>();

    await invoke({ handler, context: context(), respond, request: { agentId: "main" } });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(runConversationTurn).not.toHaveBeenCalled();
  });

  it("joins concurrent retries and replays the completed idempotent result", async () => {
    let finish: ((value: typeof result) => void) | undefined;
    const runConversationTurn = vi.fn(
      async () =>
        await new Promise<typeof result>((resolve) => {
          finish = resolve;
        }),
    );
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationSend: vi.fn(),
      runConversationTurn,
    })["conversations.turn"]!;
    const gatewayContext = context();
    const firstRespond = vi.fn<RespondFn>();
    const secondRespond = vi.fn<RespondFn>();
    const first = invoke({ handler, context: gatewayContext, respond: firstRespond });
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledOnce());
    expect(runConversationTurn).toHaveBeenCalledWith(
      expect.objectContaining({ senderIsOwner: true }),
    );
    const timeoutMismatchRespond = vi.fn<RespondFn>();
    await invoke({
      handler,
      context: gatewayContext,
      respond: timeoutMismatchRespond,
      request: { ...request, timeoutMs: 5_000 },
    });
    expect(timeoutMismatchRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    const second = invoke({ handler, context: gatewayContext, respond: secondRespond });
    finish?.(result);
    await Promise.all([first, second]);

    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(firstRespond).toHaveBeenCalledWith(true, result, undefined, { channel: "reef" });
    expect(secondRespond).toHaveBeenCalledWith(true, result, undefined, {
      channel: "reef",
      cached: true,
    });

    const cachedRespond = vi.fn<RespondFn>();
    await invoke({ handler, context: gatewayContext, respond: cachedRespond });
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(cachedRespond).toHaveBeenCalledWith(true, result, undefined, { cached: true });

    for (const key of gatewayContext.dedupe.keys()) {
      if (key.endsWith(":identity")) {
        gatewayContext.dedupe.delete(key);
      }
    }
    const mismatchedRespond = vi.fn<RespondFn>();
    await invoke({
      handler,
      context: gatewayContext,
      respond: mismatchedRespond,
      request: { ...request, message: "different message" },
    });
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(mismatchedRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });

  it("keeps concurrent turn IDs isolated between agents", async () => {
    let finish: ((value: typeof result) => void) | undefined;
    const otherResult = { ...result, messageId: "reef-outbound-other" };
    const runConversationTurn = vi.fn(
      async ({ agentId }: Parameters<typeof runGatewayConversationTurn>[0]) =>
        agentId === "main"
          ? await new Promise<typeof result>((resolve) => {
              finish = resolve;
            })
          : otherResult,
    );
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationSend: vi.fn(),
      runConversationTurn,
    })["conversations.turn"]!;
    const gatewayContext = context();
    const firstRespond = vi.fn<RespondFn>();
    const otherRespond = vi.fn<RespondFn>();
    const first = invoke({ handler, context: gatewayContext, respond: firstRespond });
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledOnce());

    const other = invoke({
      handler,
      context: gatewayContext,
      respond: otherRespond,
      request: { ...request, agentId: "other-agent" },
    });
    await vi.waitFor(() => expect(runConversationTurn).toHaveBeenCalledTimes(2));
    finish?.(result);
    await Promise.all([first, other]);

    expect(firstRespond).toHaveBeenCalledWith(true, result, undefined, { channel: "reef" });
    expect(otherRespond).toHaveBeenCalledWith(true, otherResult, undefined, {
      channel: "reef",
    });
  });

  it("retries transient unavailable failures instead of caching them", async () => {
    const runConversationTurn = vi
      .fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValueOnce(result);
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationSend: vi.fn(),
      runConversationTurn,
    })["conversations.turn"]!;
    const gatewayContext = context();
    const failedRespond = vi.fn<RespondFn>();

    await invoke({ handler, context: gatewayContext, respond: failedRespond });
    expect(failedRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "UNAVAILABLE" }),
      expect.any(Object),
    );

    const retryRespond = vi.fn<RespondFn>();
    await invoke({ handler, context: gatewayContext, respond: retryRespond });
    expect(runConversationTurn).toHaveBeenCalledTimes(2);
    expect(retryRespond).toHaveBeenCalledWith(true, result, undefined, { channel: "reef" });
  });

  it("does not let a durable operation conflict poison the authoritative retry identity", async () => {
    const runConversationTurn = vi
      .fn()
      .mockRejectedValueOnce(
        new ConversationOperationConflictError(
          `Conversation delivery operation was reused with different input: ${request.turnId}`,
        ),
      )
      .mockResolvedValueOnce(result);
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationSend: vi.fn(),
      runConversationTurn,
    })["conversations.turn"]!;
    const gatewayContext = context();
    const conflictRespond = vi.fn<RespondFn>();

    await invoke({
      handler,
      context: gatewayContext,
      respond: conflictRespond,
      request: { ...request, message: "conflicting message" },
    });
    expect(conflictRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({ code: "INVALID_REQUEST" }),
      expect.any(Object),
    );
    expect([...gatewayContext.dedupe.keys()].some((key) => key.endsWith(":identity"))).toBe(false);

    const authoritativeRespond = vi.fn<RespondFn>();
    await invoke({ handler, context: gatewayContext, respond: authoritativeRespond });
    expect(runConversationTurn).toHaveBeenCalledTimes(2);
    expect(authoritativeRespond).toHaveBeenCalledWith(true, result, undefined, {
      channel: "reef",
    });
  });

  it("maps unsupported conversation input to a stable invalid-request response", async () => {
    const runConversationTurn = vi.fn(async () => {
      throw new ConversationInputError("Channel matrix does not support correlated turns");
    });
    const handler = createConversationHandlers({
      cancelConversationTurn: vi.fn(),
      runConversationSend: vi.fn(),
      runConversationTurn,
    })["conversations.turn"]!;
    const gatewayContext = context();
    const respond = vi.fn<RespondFn>();

    await invoke({ handler, context: gatewayContext, respond });

    expect(respond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "Channel matrix does not support correlated turns",
      }),
      expect.any(Object),
    );

    const retryRespond = vi.fn<RespondFn>();
    await invoke({ handler, context: gatewayContext, respond: retryRespond });
    expect(runConversationTurn).toHaveBeenCalledOnce();
    expect(retryRespond).toHaveBeenCalledWith(
      false,
      undefined,
      expect.objectContaining({
        code: "INVALID_REQUEST",
        message: "Channel matrix does not support correlated turns",
      }),
      { cached: true },
    );
  });

  it("cancels an abandoned turn through the active Gateway connection", async () => {
    const cancelConversationTurn = vi.fn(() => true);
    const handlers = createConversationHandlers({
      cancelConversationTurn,
      runConversationSend: vi.fn(),
      runConversationTurn: vi.fn(),
    });
    const handler = handlers["conversations.turn.cancel"]!;
    const respond = vi.fn<RespondFn>();

    await handler({
      params: { agentId: request.agentId, turnId: request.turnId },
      respond,
      context: context(),
      req: { type: "req", id: "2", method: "conversations.turn.cancel" },
      client: null,
      isWebchatConnect: () => false,
    });

    expect(cancelConversationTurn).toHaveBeenCalledWith({
      agentId: request.agentId,
      id: request.turnId,
    });
    expect(respond).toHaveBeenCalledWith(true, { cancelled: true }, undefined);
  });
});

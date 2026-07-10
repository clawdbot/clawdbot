// Clickclack tests cover gateway plugin behavior.
import { EventEmitter } from "node:events";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedClickClackAccount } from "./types.js";

class FakeSocket extends EventEmitter {
  emitErrorOnClose = false;

  close = vi.fn(() => {
    if (this.emitErrorOnClose) {
      this.emit("error", new Error("socket closed while connecting"));
    }
    this.emit("close");
  });
}

const mocks = vi.hoisted(() => ({
  createClickClackClient: vi.fn(),
  client: {
    me: vi.fn(),
    events: vi.fn(),
    eventPage: vi.fn(),
    websocket: vi.fn(),
    channelMessages: vi.fn(),
    directMessages: vi.fn(),
    thread: vi.fn(),
  },
  handleClickClackInbound: vi.fn(),
  resolveClickClackInboundAccess: vi.fn(),
  resolveWorkspaceId: vi.fn(),
}));

vi.mock("./access.js", () => ({
  resolveClickClackInboundAccess: mocks.resolveClickClackInboundAccess,
}));

vi.mock("./http-client.js", () => ({
  createClickClackClient: mocks.createClickClackClient,
  normalizeClickClackCorrelationId: (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/u.test(value) ? value : undefined,
}));

vi.mock("./inbound.js", () => ({
  handleClickClackInbound: mocks.handleClickClackInbound,
}));

vi.mock("./resolve.js", () => ({
  resolveWorkspaceId: mocks.resolveWorkspaceId,
}));

import { startClickClackGatewayAccount } from "./gateway.js";

function createGatewayContext(
  abortSignal: AbortSignal,
): ChannelGatewayContext<ResolvedClickClackAccount> {
  const setStatus = vi.fn();
  const log = { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    cfg: {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          token: "test-token",
          workspace: "main",
          reconnectMs: 1,
        },
      },
    } as ChannelGatewayContext<ResolvedClickClackAccount>["cfg"],
    accountId: "default",
    account: {} as ResolvedClickClackAccount,
    runtime: {} as ChannelGatewayContext<ResolvedClickClackAccount>["runtime"],
    abortSignal,
    log,
    getStatus: () =>
      ({ accountId: "default" }) as ReturnType<
        ChannelGatewayContext<ResolvedClickClackAccount>["getStatus"]
      >,
    setStatus,
  };
}

function createBacklogEvent(index: number, type = "channel.updated") {
  return {
    id: `evt-${index}`,
    cursor: `cursor-${index}`,
    type,
    workspace_id: "workspace-1",
    channel_id: "chan-1",
    seq: index,
    created_at: "2026-01-01T00:00:00.000Z",
    payload: type === "message.created" ? { message_id: "msg-1", author_id: "human-1" } : undefined,
  };
}

describe("ClickClack gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createClickClackClient.mockReturnValue(mocks.client);
    mocks.client.me.mockResolvedValue({
      id: "bot-user",
      display_name: "Bot",
      handle: "bot",
      avatar_url: "",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    mocks.client.eventPage.mockResolvedValue({ events: [] });
    mocks.resolveClickClackInboundAccess.mockResolvedValue({
      shouldDispatch: true,
      commandAuthorized: true,
    });
    mocks.resolveWorkspaceId.mockResolvedValue("workspace-1");
    mocks.client.channelMessages.mockResolvedValue([
      {
        id: "msg-1",
        workspace_id: "workspace-1",
        channel_id: "chan-1",
        author_id: "human-1",
        thread_root_id: "msg-1",
        body: "hello",
        body_format: "markdown",
        created_at: "2026-01-01T00:00:00.000Z",
        author: {
          id: "human-1",
          kind: "human",
          display_name: "Human",
          handle: "human",
          avatar_url: "",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
  });

  it("opens realtime from the server startup tail without dispatching the returned page", async () => {
    mocks.client.eventPage.mockResolvedValueOnce({
      events: [createBacklogEvent(1)],
      tailCursor: "cursor-501",
    });
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    expect(mocks.client.eventPage).toHaveBeenCalledWith("workspace-1", { includeTail: true });
    expect(mocks.client.websocket).toHaveBeenCalledWith("workspace-1", "cursor-501");
    expect(mocks.handleClickClackInbound).not.toHaveBeenCalled();

    abort.abort();
    await run;
  });

  it("drains and processes every reconnect page before reopening realtime", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const firstReconnectPage = Array.from({ length: 500 }, (_, index) =>
      createBacklogEvent(index + 1),
    );
    mocks.client.eventPage
      .mockResolvedValueOnce({ events: [], tailCursor: "" })
      .mockResolvedValueOnce({ events: firstReconnectPage })
      .mockResolvedValueOnce({ events: [createBacklogEvent(501, "message.created")] });
    mocks.client.websocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));
    firstSocket.emit("close");
    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(2));

    expect(mocks.client.eventPage).toHaveBeenNthCalledWith(2, "workspace-1", {
      afterCursor: "",
      limit: 500,
    });
    expect(mocks.client.eventPage).toHaveBeenNthCalledWith(3, "workspace-1", {
      afterCursor: "cursor-500",
      limit: 500,
    });
    expect(mocks.client.eventPage).toHaveBeenNthCalledWith(4, "workspace-1", {
      afterCursor: "cursor-501",
      limit: 500,
    });
    expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(1);
    expect(mocks.client.websocket).toHaveBeenLastCalledWith("workspace-1", "cursor-501");

    abort.abort();
    await run;
  });

  it("skips malformed websocket frames without stopping the monitor", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    let runError: unknown;
    const run = startClickClackGatewayAccount(ctx).catch((error: unknown) => {
      runError = error;
    });

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit("message", Buffer.from("{not json"));
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    expect(runError).toBeUndefined();
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      "[default] skipped malformed ClickClack websocket event",
    );

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: "evt-1",
          cursor: "cursor-1",
          type: "message.created",
          workspace_id: "workspace-1",
          channel_id: "chan-1",
          seq: 2,
          created_at: "2026-01-01T00:00:00.000Z",
          payload: { message_id: "msg-1", author_id: "human-1" },
        }),
      ),
    );

    await vi.waitFor(() => expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(1));
    expect(mocks.handleClickClackInbound.mock.calls[0]?.[0].access).toEqual({
      shouldDispatch: true,
      commandAuthorized: true,
    });
    expect(mocks.createClickClackClient).toHaveBeenCalledTimes(1);
    expect(mocks.handleClickClackInbound.mock.calls[0]?.[0]).not.toHaveProperty("correlationId");
    abort.abort();
    await run;
    expect(runError).toBeUndefined();
  });

  it("drops messages denied by ClickClack sender access before inbound handling", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    mocks.resolveClickClackInboundAccess.mockResolvedValue({
      shouldDispatch: false,
      commandAuthorized: false,
    });
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: "evt-1",
          cursor: "cursor-1",
          type: "message.created",
          workspace_id: "workspace-1",
          channel_id: "chan-1",
          seq: 2,
          created_at: "2026-01-01T00:00:00.000Z",
          payload: { message_id: "msg-1", author_id: "human-1" },
        }),
      ),
    );

    await vi.waitFor(() => expect(mocks.resolveClickClackInboundAccess).toHaveBeenCalledTimes(1));
    expect(mocks.handleClickClackInbound).not.toHaveBeenCalled();
    abort.abort();
    await run;
  });

  it("carries validated event correlation through the authoritative fetch and inbound turn", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: "evt-1",
          cursor: "cursor-1",
          type: "message.created",
          workspace_id: "workspace-1",
          channel_id: "chan-1",
          seq: 2,
          created_at: "2026-01-01T00:00:00.000Z",
          payload: {
            message_id: "msg-1",
            author_id: "human-1",
            correlation_id: "fakeco.case_1",
          },
        }),
      ),
    );

    await vi.waitFor(() => expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(1));
    expect(mocks.createClickClackClient).toHaveBeenLastCalledWith({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      correlationId: "fakeco.case_1",
    });
    expect(mocks.client.channelMessages).toHaveBeenCalledWith("chan-1", 1, 10);
    expect(mocks.handleClickClackInbound).toHaveBeenCalledWith(
      expect.objectContaining({ correlationId: "fakeco.case_1" }),
    );

    abort.abort();
    await run;
  });

  it("omits invalid payload correlation without dropping the event", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: "evt-1",
          cursor: "cursor-1",
          type: "message.created",
          workspace_id: "workspace-1",
          channel_id: "chan-1",
          seq: 2,
          created_at: "2026-01-01T00:00:00.000Z",
          payload: {
            message_id: "msg-1",
            author_id: "human-1",
            correlation_id: "bad correlation",
          },
        }),
      ),
    );

    await vi.waitFor(() => expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(1));
    expect(mocks.createClickClackClient).toHaveBeenCalledTimes(1);
    expect(mocks.handleClickClackInbound.mock.calls[0]?.[0]).not.toHaveProperty("correlationId");

    abort.abort();
    await run;
  });

  it("reconnects after ClickClack websocket errors", async () => {
    const firstSocket = new FakeSocket();
    firstSocket.emitErrorOnClose = true;
    const secondSocket = new FakeSocket();
    mocks.client.websocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    firstSocket.emit("error", new Error("gateway dropped"));

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(2));
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      "[default] ClickClack websocket error; reconnecting: gateway dropped",
    );
    abort.abort();
    await run;
  });

  it("does not log reconnect warnings when abort closes a connecting websocket", async () => {
    const socket = new FakeSocket();
    socket.emitErrorOnClose = true;
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    abort.abort();
    await run;

    expect(ctx.log?.warn).not.toHaveBeenCalledWith(
      "[default] ClickClack websocket error; reconnecting: socket closed while connecting",
    );
    expect(mocks.client.websocket).toHaveBeenCalledTimes(1);
  });

  it("clears running status when backlog polling fails", async () => {
    mocks.client.eventPage.mockRejectedValue(new Error("clickclack unavailable"));
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);

    await expect(startClickClackGatewayAccount(ctx)).rejects.toThrow("clickclack unavailable");

    expect(ctx.setStatus).toHaveBeenCalledWith({
      accountId: "default",
      running: true,
      configured: true,
      enabled: true,
      baseUrl: "https://clickclack.example",
    });
    expect(ctx.setStatus).toHaveBeenLastCalledWith({
      accountId: "default",
      running: false,
    });
  });

  it("wraps non-Error ws message rejections with the original value in the message", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const rejection = { code: "ECONNRESET", retryable: true };
    mocks.resolveClickClackInboundAccess.mockRejectedValue(rejection);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    socket.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          id: "evt-1",
          cursor: "cursor-1",
          type: "message.created",
          workspace_id: "workspace-1",
          channel_id: "chan-1",
          seq: 2,
          created_at: "2026-01-01T00:00:00.000Z",
          payload: { message_id: "msg-1", author_id: "human-1" },
        }),
      ),
    );

    await expect(run).rejects.toMatchObject({
      message: 'ClickClack ws message failed: {"code":"ECONNRESET","retryable":true}',
      cause: rejection,
    });
    expect(ctx.setStatus).toHaveBeenLastCalledWith({
      accountId: "default",
      running: false,
    });
  });
});

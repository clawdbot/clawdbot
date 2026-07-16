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
    setBotCommands: vi.fn(),
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

vi.mock("openclaw/plugin-sdk/native-command-registry", () => ({
  listNativeCommandSpecsForConfig: () => [],
}));

vi.mock("./resolve.js", () => ({
  resolveWorkspaceId: mocks.resolveWorkspaceId,
}));

import { startClickClackGatewayAccount } from "./gateway.js";

function createGatewayContext(
  abortSignal: AbortSignal,
  options: {
    commandMenu?: boolean;
  } = {},
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
          ...(options.commandMenu === undefined ? {} : { commandMenu: options.commandMenu }),
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

function emitMessageEvent(
  socket: FakeSocket,
  index: number,
  payload: Record<string, unknown> = {},
) {
  const event = createBacklogEvent(index, "message.created");
  socket.emit(
    "message",
    Buffer.from(
      JSON.stringify({ ...event, seq: index + 1, payload: { ...event.payload, ...payload } }),
    ),
  );
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
    mocks.client.setBotCommands.mockResolvedValue([]);
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

  it.each([
    { label: "unset", commandMenu: undefined },
    { label: "enabled", commandMenu: true },
  ])("syncs the native command menu before startup when $label", async ({ commandMenu }) => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal, { commandMenu });
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    expect(mocks.client.setBotCommands).toHaveBeenCalledTimes(1);
    expect(mocks.client.me.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.client.setBotCommands.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.client.setBotCommands.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.client.eventPage.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.client.setBotCommands.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ctx.setStatus).mock.invocationCallOrder[0] ?? 0,
    );

    abort.abort();
    await run;
  });

  it("skips command menu sync when explicitly disabled", async () => {
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal, { commandMenu: false });
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    expect(mocks.client.setBotCommands).not.toHaveBeenCalled();

    abort.abort();
    await run;
  });

  it.each([
    {
      label: "missing command scope",
      error: { status: 403 },
      level: "warn" as const,
      message: "ClickClack command menu sync skipped: bot token lacks commands:write",
    },
    {
      label: "older server",
      error: { status: 404 },
      level: "debug" as const,
      message:
        "ClickClack command menu sync skipped: server does not support /api/bots/self/commands",
    },
    {
      label: "network failure",
      error: new Error("network unavailable"),
      level: "warn" as const,
      message: "ClickClack command menu sync failed: network unavailable",
    },
  ])("continues startup after $label", async ({ error, level, message }) => {
    mocks.client.setBotCommands.mockRejectedValueOnce(error);
    const socket = new FakeSocket();
    mocks.client.websocket.mockReturnValue(socket);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    expect(ctx.log?.[level]).toHaveBeenCalledWith(message);
    expect(ctx.setStatus).toHaveBeenCalledWith({
      accountId: "default",
      running: true,
      configured: true,
      enabled: true,
      baseUrl: "https://clickclack.example",
    });

    abort.abort();
    await run;
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

    emitMessageEvent(socket, 1);

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

  it("processes websocket events in order before reconnecting from their cursor", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    mocks.client.websocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    let finishFirstEvent: (() => void) | undefined;
    mocks.handleClickClackInbound.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirstEvent = resolve;
        }),
    );
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    for (const index of [1, 2]) {
      emitMessageEvent(firstSocket, index);
    }
    firstSocket.emit("close");

    await vi.waitFor(() => expect(finishFirstEvent).toBeTypeOf("function"));
    expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(1);
    expect(mocks.client.websocket).toHaveBeenCalledTimes(1);

    finishFirstEvent?.();
    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(2));

    expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(2);
    expect(mocks.client.eventPage).toHaveBeenLastCalledWith("workspace-1", {
      afterCursor: "cursor-2",
      limit: 500,
    });

    abort.abort();
    await run;
  });

  it("replays a failed websocket event on reconnect without processing later queued events", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const events = [
      createBacklogEvent(1, "message.created"),
      createBacklogEvent(2, "message.created"),
    ];
    mocks.client.eventPage
      .mockResolvedValueOnce({ events: [], tailCursor: "" })
      .mockResolvedValueOnce({ events })
      .mockResolvedValueOnce({ events: [] });
    mocks.client.websocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    mocks.handleClickClackInbound.mockRejectedValueOnce(new Error("dispatch failed"));
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    for (const index of [1, 2]) {
      emitMessageEvent(firstSocket, index);
    }

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(2));

    expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(3);
    expect(firstSocket.close).toHaveBeenCalledOnce();
    expect(mocks.client.eventPage).toHaveBeenNthCalledWith(2, "workspace-1", {
      afterCursor: "",
      limit: 500,
    });
    expect(mocks.client.websocket).toHaveBeenLastCalledWith("workspace-1", "cursor-2");
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      "[default] ClickClack event processing failed; reconnecting: dispatch failed",
    );

    abort.abort();
    await run;
  });

  it("does not serialize unrelated gateway streams", async () => {
    const slowSocket = new FakeSocket();
    const fastSocket = new FakeSocket();
    mocks.client.websocket.mockReturnValueOnce(slowSocket).mockReturnValueOnce(fastSocket);
    let finishSlowEvent: (() => void) | undefined;
    mocks.handleClickClackInbound.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSlowEvent = resolve;
        }),
    );
    const slowAbort = new AbortController();
    const fastAbort = new AbortController();
    const slowRun = startClickClackGatewayAccount(createGatewayContext(slowAbort.signal));
    const fastRun = startClickClackGatewayAccount(createGatewayContext(fastAbort.signal));

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(2));

    emitMessageEvent(slowSocket, 1);
    await vi.waitFor(() => expect(finishSlowEvent).toBeTypeOf("function"));
    emitMessageEvent(fastSocket, 2);

    await vi.waitFor(() => expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(2));
    expect(finishSlowEvent).toBeTypeOf("function");

    finishSlowEvent?.();
    slowAbort.abort();
    fastAbort.abort();
    await Promise.all([slowRun, fastRun]);
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

    emitMessageEvent(socket, 1);

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

    emitMessageEvent(socket, 1, { correlation_id: "fakeco.case_1" });

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

    emitMessageEvent(socket, 1, { correlation_id: "bad correlation" });

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

  it("cancels the reconnect delay when the gateway aborts", async () => {
    vi.useFakeTimers();
    try {
      const firstSocket = new FakeSocket();
      const secondSocket = new FakeSocket();
      mocks.client.websocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
      const abort = new AbortController();
      const ctx = createGatewayContext(abort.signal);
      const run = startClickClackGatewayAccount(ctx);

      await vi.advanceTimersByTimeAsync(0);
      expect(mocks.client.websocket).toHaveBeenCalledTimes(1);

      firstSocket.emit("close");
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);

      abort.abort();
      await run;

      expect(vi.getTimerCount()).toBe(0);
      expect(mocks.client.websocket).toHaveBeenCalledTimes(1);
      expect(ctx.setStatus).toHaveBeenLastCalledWith({
        accountId: "default",
        running: false,
      });
    } finally {
      vi.useRealTimers();
    }
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

  it("logs non-Error websocket failures before replaying them", async () => {
    const firstSocket = new FakeSocket();
    const secondSocket = new FakeSocket();
    const event = createBacklogEvent(1, "message.created");
    mocks.client.eventPage
      .mockResolvedValueOnce({ events: [], tailCursor: "" })
      .mockResolvedValueOnce({ events: [event] })
      .mockResolvedValueOnce({ events: [] });
    mocks.client.websocket.mockReturnValueOnce(firstSocket).mockReturnValueOnce(secondSocket);
    const rejection = { code: "ECONNRESET", retryable: true };
    mocks.resolveClickClackInboundAccess.mockRejectedValueOnce(rejection);
    const abort = new AbortController();
    const ctx = createGatewayContext(abort.signal);
    const run = startClickClackGatewayAccount(ctx);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(1));

    emitMessageEvent(firstSocket, 1);

    await vi.waitFor(() => expect(mocks.client.websocket).toHaveBeenCalledTimes(2));
    expect(ctx.log?.warn).toHaveBeenCalledWith(
      '[default] ClickClack event processing failed; reconnecting: {"code":"ECONNRESET","retryable":true}',
    );
    expect(mocks.client.websocket).toHaveBeenLastCalledWith("workspace-1", "cursor-1");

    abort.abort();
    await run;
  });
});

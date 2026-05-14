import { EventEmitter } from "node:events";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ResolvedClickClackAccount } from "./types.js";

class FakeSocket extends EventEmitter {
  close = vi.fn(() => {
    this.emit("close");
  });
}

const mocks = vi.hoisted(() => ({
  client: {
    me: vi.fn(),
    events: vi.fn(),
    websocket: vi.fn(),
    channelMessages: vi.fn(),
    directMessages: vi.fn(),
    thread: vi.fn(),
  },
  handleClickClackInbound: vi.fn(),
  resolveWorkspaceId: vi.fn(),
}));

vi.mock("./http-client.js", () => ({
  createClickClackClient: vi.fn(() => mocks.client),
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

describe("ClickClack gateway", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.me.mockResolvedValue({
      id: "bot-user",
      display_name: "Bot",
      handle: "bot",
      avatar_url: "",
      created_at: "2026-01-01T00:00:00.000Z",
    });
    mocks.client.events.mockResolvedValue([]);
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
    await new Promise((resolve) => setImmediate(resolve));
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
    abort.abort();
    await run;
    expect(runError).toBeUndefined();
  });
});

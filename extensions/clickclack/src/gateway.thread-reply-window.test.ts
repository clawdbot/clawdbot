import { createServer } from "node:http";
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import type { ClickClackMessage, ResolvedClickClackAccount } from "./types.js";

const CLICKCLACK_THREAD_DEFAULT_LIMIT = 100;

const mocks = vi.hoisted(() => ({
  handleClickClackInbound: vi.fn(),
  resolveClickClackInboundAccess: vi.fn(),
}));

vi.mock("./inbound.js", () => ({
  handleClickClackInbound: mocks.handleClickClackInbound,
}));

vi.mock("./access.js", () => ({
  resolveClickClackInboundAccess: mocks.resolveClickClackInboundAccess,
}));

const { startClickClackGatewayAccount } = await import("./gateway.js");

function threadReply(index: number): ClickClackMessage {
  return {
    id: `msg-${index}`,
    workspace_id: "wsp_1",
    channel_id: "chn_1",
    author_id: "usr_human",
    parent_message_id: "msg_root",
    thread_root_id: "msg_root",
    thread_seq: index,
    body: `reply ${index}`,
    body_format: "markdown",
    created_at: "2026-01-01T00:00:00.000Z",
    author: {
      id: "usr_human",
      kind: "human",
      display_name: "Human",
      handle: "human",
      avatar_url: "",
      created_at: "2026-01-01T00:00:00.000Z",
    },
  };
}

const THREAD_ROOT: ClickClackMessage = {
  id: "msg_root",
  workspace_id: "wsp_1",
  channel_id: "chn_1",
  author_id: "usr_human",
  thread_root_id: "msg_root",
  channel_seq: 1,
  body: "root",
  body_format: "markdown",
  created_at: "2026-01-01T00:00:00.000Z",
};

const ALL_REPLIES = Array.from({ length: 101 }, (_, index) => threadReply(index + 1));
const LATEST_REPLY = ALL_REPLIES[ALL_REPLIES.length - 1];

const DM_ROOT: ClickClackMessage = {
  id: "msg_dm_root",
  workspace_id: "wsp_1",
  direct_conversation_id: "dmc_1",
  author_id: "usr_human",
  thread_root_id: "msg_dm_root",
  channel_seq: 1,
  body: "dm root",
  body_format: "markdown",
  created_at: "2026-01-01T00:00:00.000Z",
};

const DM_THREAD_REPLY: ClickClackMessage = {
  id: "msg_dm_reply",
  workspace_id: "wsp_1",
  direct_conversation_id: "dmc_1",
  author_id: "usr_human",
  parent_message_id: "msg_dm_root",
  thread_root_id: "msg_dm_root",
  thread_seq: 1,
  body: "dm thread reply",
  body_format: "markdown",
  created_at: "2026-01-01T00:00:00.000Z",
};

const RESOLVABLE_MESSAGES = [...ALL_REPLIES, DM_THREAD_REPLY];

type ClickClackTestServer = {
  apiBaseUrl: string;
  requestPaths: string[];
  emitThreadReplyEvent: (messageId: string, payload?: Record<string, string>) => Promise<void>;
  close: () => Promise<void>;
  missingMessageIds: Set<string>;
};

async function startClickClackTestServer(): Promise<ClickClackTestServer> {
  const requestPaths: string[] = [];
  const missingMessageIds = new Set<string>();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    requestPaths.push(`${req.method} ${url.pathname}${url.search}`);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/me") {
      json(200, {
        user: {
          id: "usr_bot",
          kind: "bot",
          display_name: "Bot",
          handle: "bot",
          avatar_url: "",
          created_at: "2026-01-01T00:00:00.000Z",
        },
      });
      return;
    }
    if (url.pathname === "/api/workspaces") {
      json(200, {
        workspaces: [
          {
            id: "wsp_1",
            route_id: "rt_1",
            name: "Main",
            slug: "main",
            created_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      });
      return;
    }
    if (url.pathname === "/api/realtime/events") {
      json(200, { events: [], tail_cursor: "cursor-0" });
      return;
    }
    const threadMatch = url.pathname.match(/^\/api\/messages\/([^/]+)\/thread$/u);
    if (threadMatch) {
      const requestedLimit = Number(url.searchParams.get("limit"));
      const limit =
        Number.isSafeInteger(requestedLimit) && requestedLimit > 0
          ? Math.min(requestedLimit, 200)
          : CLICKCLACK_THREAD_DEFAULT_LIMIT;
      const window =
        url.searchParams.get("latest") === "true"
          ? ALL_REPLIES.slice(-limit)
          : ALL_REPLIES.slice(0, limit);
      json(200, {
        root: THREAD_ROOT,
        replies: window,
        thread_state: {
          root_message_id: "msg_root",
          reply_count: ALL_REPLIES.length,
          last_reply_at: LATEST_REPLY?.created_at,
          last_reply_author_ids: ["usr_human"],
        },
      });
      return;
    }
    if (/^\/api\/dms\/[^/]+\/messages$/u.test(url.pathname)) {
      json(200, { messages: [DM_ROOT], oldest_seq: 1, has_older: false });
      return;
    }
    const messageMatch = url.pathname.match(/^\/api\/messages\/([^/]+)$/u);
    if (messageMatch) {
      const messageId = decodeURIComponent(messageMatch[1] ?? "");
      const message = missingMessageIds.has(messageId)
        ? undefined
        : RESOLVABLE_MESSAGES.find((candidate) => candidate.id === messageId);
      if (!message) {
        json(404, { error: "message not found" });
        return;
      }
      json(200, { message });
      return;
    }
    json(404, { error: `unhandled ${url.pathname}` });
  });
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("expected loopback TCP address"));
        return;
      }
      resolve(address.port);
    });
  });
  const wss = new WebSocketServer({ server, path: "/api/realtime/ws" });
  const sockets = new Set<import("ws").WebSocket>();
  wss.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return {
    apiBaseUrl: `http://127.0.0.1:${port}`,
    requestPaths,
    missingMessageIds,
    emitThreadReplyEvent: async (messageId: string, payload: Record<string, string> = {}) => {
      await vi.waitFor(() => expect(sockets.size).toBe(1));
      const frame = JSON.stringify({
        id: "evt-1",
        cursor: "cursor-1",
        type: "thread.reply_created",
        workspace_id: "wsp_1",
        channel_id: "chn_1",
        seq: 1,
        created_at: "2026-01-01T00:00:00.000Z",
        payload: {
          message_id: messageId,
          root_message_id: "msg_root",
          author_id: "usr_human",
          ...payload,
        },
      });
      for (const socket of sockets) {
        socket.send(frame);
      }
    },
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

function createGatewayContext(
  apiBaseUrl: string,
  abortSignal: AbortSignal,
): ChannelGatewayContext<ResolvedClickClackAccount> {
  return {
    cfg: {
      channels: {
        clickclack: {
          baseUrl: "https://clickclack.example",
          apiBaseUrl,
          token: "test-token",
          workspace: "main",
          reconnectMs: 5,
          commandMenu: false,
        },
      },
    } as ChannelGatewayContext<ResolvedClickClackAccount>["cfg"],
    accountId: "default",
    account: {} as ResolvedClickClackAccount,
    runtime: {} as ChannelGatewayContext<ResolvedClickClackAccount>["runtime"],
    abortSignal,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    getStatus: () =>
      ({ accountId: "default" }) as ReturnType<
        ChannelGatewayContext<ResolvedClickClackAccount>["getStatus"]
      >,
    setStatus: vi.fn(),
  };
}

describe("ClickClack gateway thread reply resolution", () => {
  let testServer: ClickClackTestServer;
  let abort: AbortController | undefined;
  let run: Promise<void> | undefined;

  function startGateway(): ChannelGatewayContext<ResolvedClickClackAccount> {
    abort = new AbortController();
    const ctx = createGatewayContext(testServer.apiBaseUrl, abort.signal);
    run = startClickClackGatewayAccount(ctx);
    return ctx;
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    abort = undefined;
    run = undefined;
    mocks.resolveClickClackInboundAccess.mockResolvedValue({
      shouldDispatch: true,
      commandAuthorized: true,
    });
    testServer = await startClickClackTestServer();
  });

  afterEach(async () => {
    try {
      abort?.abort();
      if (run) {
        await run;
      }
    } finally {
      await testServer.close();
    }
  });

  it("dispatches a thread reply past the server thread-reply window", async () => {
    const ctx = startGateway();

    await testServer.emitThreadReplyEvent("msg-101");
    await vi.waitFor(() => expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(1));

    expect(mocks.handleClickClackInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ id: "msg-101", body: "reply 101" }),
      }),
    );
    expect(testServer.requestPaths).toContain("GET /api/messages/msg-101");
    expect(ctx.log?.warn).not.toHaveBeenCalled();
  });

  it("dispatches a DM thread reply that never enters the root DM timeline", async () => {
    startGateway();

    await testServer.emitThreadReplyEvent("msg_dm_reply", {
      direct_conversation_id: "dmc_1",
      root_message_id: "msg_dm_root",
    });
    await vi.waitFor(() => expect(mocks.handleClickClackInbound).toHaveBeenCalledTimes(1));

    expect(mocks.handleClickClackInbound).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.objectContaining({ id: "msg_dm_reply", body: "dm thread reply" }),
      }),
    );
    expect(testServer.requestPaths).toContain("GET /api/messages/msg_dm_reply");
  });

  it("records a warning instead of silently handling an unreadable event message", async () => {
    testServer.missingMessageIds.add("msg-101");
    const ctx = startGateway();

    await testServer.emitThreadReplyEvent("msg-101");
    await vi.waitFor(() =>
      expect(ctx.log?.warn).toHaveBeenCalledWith(
        expect.stringContaining("skipped unreadable ClickClack message before agent dispatch"),
      ),
    );

    expect(mocks.handleClickClackInbound).not.toHaveBeenCalled();
  });
});

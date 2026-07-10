import { createServer, type Server } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { createClickClackClient, normalizeClickClackCorrelationId } from "./http-client.js";

const LOOPBACK_RESPONSE_BYTES = 18 * 1024 * 1024;
const CLICKCLACK_REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;
const CLICKCLACK_INBOUND_JSON_LIMIT_BYTES = 16 * 1024 * 1024;

function requestBodyJson(init: RequestInit | undefined): unknown {
  const body = init?.body;
  if (typeof body !== "string") {
    throw new Error("expected string request body");
  }
  return JSON.parse(body);
}

async function listenLoopbackServer(server: Server): Promise<number> {
  return await new Promise((resolve, reject) => {
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
}

function createOversizedJsonServer(): { server: Server; closed: Promise<number> } {
  let resolveClosed: (sentBytes: number) => void = () => {};
  const closed = new Promise<number>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((req, res) => {
    let sentBytes = 0;
    let stopped = false;
    let prefixSent = false;
    const prefixChunk = Buffer.from('{"user":{"id":"');
    const bodyChunk = Buffer.alloc(64 * 1024, 0x61);
    const suffixChunk = Buffer.from('"}}');
    const writeBuffer = (buffer: Buffer) => {
      sentBytes += buffer.length;
      if (!res.write(buffer)) {
        res.once("drain", writeChunks);
        return false;
      }
      return true;
    };
    const writeChunks = () => {
      if (!prefixSent) {
        prefixSent = true;
        if (!writeBuffer(prefixChunk)) {
          return;
        }
      }
      while (true) {
        if (stopped) {
          return;
        }
        if (sentBytes + bodyChunk.length + suffixChunk.length >= LOOPBACK_RESPONSE_BYTES) {
          break;
        }
        if (!writeBuffer(bodyChunk)) {
          return;
        }
      }
      if (!stopped) {
        sentBytes += suffixChunk.length;
        res.end(suffixChunk);
      }
    };
    res.writeHead(200, { connection: "close", "content-type": "application/json" });
    res.on("close", () => {
      stopped = true;
      resolveClosed(sentBytes);
    });
    req.on("aborted", () => {
      stopped = true;
      res.destroy();
    });
    writeChunks();
  });
  return { server, closed };
}

function streamedErrorResponse(body: string, limit: number) {
  const encoded = new TextEncoder().encode(body);
  let readCount = 0;
  const cancel = vi.fn(async () => undefined);
  const releaseLock = vi.fn();
  const text = vi.fn(async () => {
    throw new Error("raw response.text() should not be used");
  });

  const response = {
    ok: false,
    status: 502,
    text,
    body: {
      getReader: () => ({
        read: async () => {
          if (readCount > 0) {
            return { done: true, value: undefined };
          }
          readCount += 1;
          return { done: false, value: encoded };
        },
        cancel,
        releaseLock,
      }),
    },
  } as unknown as Response;

  return {
    response,
    cancel,
    releaseLock,
    text,
    expectedDetail: body.slice(0, limit),
  };
}

describe("ClickClack HTTP client", () => {
  it("adds paged tail queries without changing the legacy events result", async () => {
    const fetchMock = vi.fn(async () => Response.json({ events: [], tail_cursor: "cursor-900" }));
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock,
    });

    const page = await client.eventPage("workspace-1", {
      afterCursor: "cursor-500",
      limit: 500,
      includeTail: true,
    });
    const legacyEvents = await client.events("workspace-1", "cursor-900");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://clickclack.example/api/realtime/events?workspace_id=workspace-1&after_cursor=cursor-500&limit=500&include_tail=true",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://clickclack.example/api/realtime/events?workspace_id=workspace-1&after_cursor=cursor-900",
      expect.any(Object),
    );
    expect(page).toEqual({ events: [], tailCursor: "cursor-900" });
    expect(legacyEvents).toEqual([]);
  });

  it("sends only safe bounded request correlation", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ user: { id: "usr_1" } }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      correlationId: " fakeco.case_1 ",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.me();

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.get("X-Correlation-ID")).toBe("fakeco.case_1");
    expect(normalizeClickClackCorrelationId("bad\ncorrelation")).toBeUndefined();
    expect(normalizeClickClackCorrelationId("x".repeat(129))).toBeUndefined();
  });

  it("omits invalid request correlation instead of constructing an unsafe header", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ user: { id: "usr_1" } }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      correlationId: "bad\rcorrelation",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.me();

    const headers = new Headers(fetchMock.mock.calls[0]?.[1]?.headers);
    expect(headers.has("X-Correlation-ID")).toBe(false);
  });

  it("bounds oversized success JSON responses and closes the stream early", async () => {
    const { server, closed } = createOversizedJsonServer();
    const port = await listenLoopbackServer(server);
    const client = createClickClackClient({
      baseUrl: `http://127.0.0.1:${port}`,
      token: "test-token",
    });

    try {
      await expect(client.me()).rejects.toThrow(
        "ClickClack response: JSON response exceeds 16777216 bytes",
      );
      const sentBytes = await closed;
      expect(sentBytes).toBeLessThan(LOOPBACK_RESPONSE_BYTES);
    } finally {
      server.close();
    }
  });

  it("bounds error response bodies without using raw response.text()", async () => {
    const streamed = streamedErrorResponse("x".repeat(9000), 8 * 1024);
    const fetchMock = vi.fn(async () => streamed.response);
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock,
    });

    await expect(client.me()).rejects.toThrow(`ClickClack 502: ${streamed.expectedDetail}`);

    expect(streamed.text).not.toHaveBeenCalled();
    expect(streamed.cancel).toHaveBeenCalledTimes(1);
    expect(streamed.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("POSTs durable activity rows with kind and turn_id", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ message: { id: "msg_9" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const message = await client.createActivityMessage({
      channelId: "chn_1",
      body: "ran bash",
      kind: "agent_tool",
      turnId: "t1",
    });

    expect(message.id).toBe("msg_9");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://clickclack.example/api/channels/chn_1/messages",
      expect.objectContaining({ method: "POST" }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(requestBodyJson(init)).toEqual({
      body: "ran bash",
      kind: "agent_tool",
      turn_id: "t1",
    });
  });

  it("includes quoted_message_id on a channel message when quoting", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ message: { id: "msg_q" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.createChannelMessage("chn_1", "ack", { quotedMessageId: "msg_root" });

    expect(requestBodyJson(fetchMock.mock.calls[0]?.[1])).toEqual({
      body: "ack",
      quoted_message_id: "msg_root",
    });
  });

  it("omits quoted_message_id on a channel message when not quoting", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ message: { id: "msg_p" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.createChannelMessage("chn_1", "hello");

    expect(requestBodyJson(fetchMock.mock.calls[0]?.[1])).toEqual({ body: "hello" });
  });

  it("includes quoted_message_id on a direct message when quoting", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ message: { id: "msg_dm_q" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.createDirectMessage("dcn_1", "ack", { quotedMessageId: "msg_root" });

    expect(requestBodyJson(fetchMock.mock.calls[0]?.[1])).toEqual({
      body: "ack",
      quoted_message_id: "msg_root",
    });
  });

  it("rejects activity rows without a channel or conversation target", async () => {
    const fetchMock = vi.fn();
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.createActivityMessage({ body: "orphan row", kind: "agent_commentary" }),
    ).rejects.toThrow("createActivityMessage requires a channelId or conversationId");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("routes DM activity rows through the conversation create path", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: { id: "msg_10" } }), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.createActivityMessage({
      conversationId: "dcn_1",
      body: "thinking about it",
      kind: "agent_commentary",
      turnId: "t1",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://clickclack.example/api/dms/dcn_1/messages",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("PATCHes message bodies for activity row coalescing", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(JSON.stringify({ message: { id: "msg_9", body: "longer" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.updateMessageBody("msg_9", "longer");

    expect(fetchMock).toHaveBeenCalledWith(
      "https://clickclack.example/api/messages/msg_9",
      expect.objectContaining({ method: "PATCH" }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(requestBodyJson(init)).toEqual({ body: "longer" });
  });
});

describe("createClickClackClient websocket", () => {
  async function runFrameCase(frame: string): Promise<{ delivered: boolean; error?: string }> {
    const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await new Promise<void>((resolve) => {
      wss.once("listening", () => resolve());
    });
    const address = wss.address();
    if (!address || typeof address === "string") {
      throw new Error("expected loopback ws address");
    }
    wss.on("connection", (server) => server.send(frame));
    const client = createClickClackClient({
      baseUrl: `http://127.0.0.1:${address.port}`,
      token: "test-token",
    });
    const socket = client.websocket("ws-1");
    try {
      return await new Promise<{ delivered: boolean; error?: string }>((resolve) => {
        socket.on("message", () => resolve({ delivered: true }));
        socket.on("error", (error) => resolve({ delivered: false, error: error.message }));
      });
    } finally {
      socket.terminate();
      await new Promise<void>((resolve, reject) => {
        wss.close((error) => (error ? reject(error) : resolve()));
      });
    }
  }

  it("delivers a legitimate inbound frame below the payload cap", async () => {
    const result = await runFrameCase(JSON.stringify({ cursor: "c1", type: "message" }));
    expect(result.delivered).toBe(true);
  });

  it("delivers a valid event frame above the server request-body limit", async () => {
    // The server wraps and re-encodes accepted request payloads, so the event
    // frame can legitimately be larger than its 1 MiB request-body limit.
    const frame = JSON.stringify({
      id: "evt-1",
      cursor: "cursor-1",
      type: "agent.progress",
      workspace_id: "workspace-1",
      created_at: "2026-07-09T00:00:00Z",
      payload: { line: { text: "x".repeat(CLICKCLACK_REQUEST_BODY_LIMIT_BYTES) } },
    });
    expect(Buffer.byteLength(frame)).toBeGreaterThan(CLICKCLACK_REQUEST_BODY_LIMIT_BYTES);

    const result = await runFrameCase(frame);
    expect(result.delivered).toBe(true);
  });

  it("rejects an oversized inbound frame before it reaches the event parser", async () => {
    const result = await runFrameCase("x".repeat(CLICKCLACK_INBOUND_JSON_LIMIT_BYTES + 1));
    expect(result.delivered).toBe(false);
    expect(result.error).toMatch(/max payload/i);
  });
});

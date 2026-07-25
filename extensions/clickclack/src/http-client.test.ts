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
  it("creates, updates, and reads managed discussion channels", async () => {
    const channel = {
      id: "chn_discussion",
      route_id: "discussion-route",
      workspace_id: "wsp_1",
      name: "release-planning",
      kind: "public",
      created_at: "2026-07-19T00:00:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ channel }, { status: 201 }))
      .mockResolvedValueOnce(Response.json({ channel }))
      .mockResolvedValueOnce(
        Response.json({ messages: [], oldest_seq: 0, newest_seq: 0, has_older: false }),
      );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock,
    });

    await client.createChannel("wsp_1", {
      name: "release-planning",
      kind: "public",
      external_managed: true,
      external_ref: "agent:main:main",
      external_url: "https://control.example/chat?session=agent%3Amain%3Amain",
      sidebar_section: "Sessions",
    });
    await client.updateChannel("chn_discussion", {
      archived: true,
      name: "release-done",
      sidebar_section: "Archive",
    });
    await client.latestChannelMessages("chn_discussion", 30);

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "https://clickclack.example/api/workspaces/wsp_1/channels",
      expect.objectContaining({ method: "POST" }),
    );
    expect(requestBodyJson(fetchMock.mock.calls[0]?.[1])).toEqual({
      name: "release-planning",
      kind: "public",
      external_managed: true,
      external_ref: "agent:main:main",
      external_url: "https://control.example/chat?session=agent%3Amain%3Amain",
      sidebar_section: "Sessions",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://clickclack.example/api/channels/chn_discussion",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(requestBodyJson(fetchMock.mock.calls[1]?.[1])).toEqual({
      archived: true,
      name: "release-done",
      sidebar_section: "Archive",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://clickclack.example/api/channels/chn_discussion/messages?limit=200",
      expect.any(Object),
    );
  });

  it("merges recent thread replies into the global latest-message window", async () => {
    const root = {
      id: "msg_root",
      workspace_id: "wsp_1",
      channel_id: "chn_discussion",
      author_id: "usr_root",
      thread_root_id: "msg_root",
      channel_seq: 10,
      body: "Old root",
      body_format: "markdown" as const,
      created_at: "2026-07-19T10:00:00.000Z",
      thread_state: {
        root_message_id: "msg_root",
        reply_count: 1,
        last_reply_at: "2026-07-19T13:00:00.000Z",
        last_reply_author_ids: ["usr_reply"],
      },
    };
    const newerRoot = {
      ...root,
      id: "msg_newer",
      author_id: "usr_newer",
      thread_root_id: "msg_newer",
      channel_seq: 11,
      body: "New root",
      created_at: "2026-07-19T12:00:00.000Z",
      thread_state: {
        root_message_id: "msg_newer",
        reply_count: 0,
        last_reply_author_ids: [],
      },
    };
    const reply = {
      ...root,
      id: "msg_reply",
      author_id: "usr_reply",
      parent_message_id: "msg_root",
      thread_seq: 1,
      body: "Recent reply",
      created_at: "2026-07-19T13:00:00.000Z",
      thread_state: undefined,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          messages: [newerRoot],
          oldest_seq: 11,
          newest_seq: 11,
          has_older: true,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          messages: [root],
          oldest_seq: 10,
          newest_seq: 10,
          has_older: false,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ root, replies: [reply], thread_state: root.thread_state }),
      );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock,
    });

    const result = await client.latestChannelMessages("chn_discussion", 2);

    expect(result).toEqual({
      messages: [
        expect.objectContaining({ id: "msg_newer" }),
        expect.objectContaining({ id: "msg_reply" }),
      ],
      truncated: false,
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://clickclack.example/api/channels/chn_discussion/messages?limit=200&before_seq=11",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "https://clickclack.example/api/messages/msg_root/thread?limit=200",
      expect.any(Object),
    );
  });

  it("fails closed when a capped thread response cannot contain the latest replies", async () => {
    const root = {
      id: "msg_root",
      workspace_id: "wsp_1",
      channel_id: "chn_discussion",
      author_id: "usr_root",
      thread_root_id: "msg_root",
      channel_seq: 1,
      body: "Root",
      body_format: "markdown" as const,
      created_at: "2026-07-19T10:00:00.000Z",
      thread_state: {
        root_message_id: "msg_root",
        reply_count: 201,
        last_reply_at: "2026-07-19T13:00:00.000Z",
        last_reply_author_ids: ["usr_reply"],
      },
    };
    const oldestReply = {
      ...root,
      id: "msg_oldest_reply",
      parent_message_id: "msg_root",
      thread_seq: 1,
      body: "Oldest reply",
      created_at: "2026-07-19T10:01:00.000Z",
      thread_state: undefined,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          messages: [root],
          oldest_seq: 1,
          newest_seq: 1,
          has_older: false,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ root, replies: [oldestReply], thread_state: root.thread_state }),
      );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock,
    });

    const result = await client.latestChannelMessages("chn_discussion", 30);

    expect(result).toEqual({ messages: [root], truncated: true });
  });

  it("bounds discussion history pagination and reports truncation", async () => {
    let sequence = 1_000;
    const fetchMock = vi.fn(async () => {
      const current = sequence;
      sequence -= 1;
      return Response.json({
        messages: [
          {
            id: `msg_${current}`,
            workspace_id: "wsp_1",
            channel_id: "chn_discussion",
            author_id: "usr_1",
            thread_root_id: `msg_${current}`,
            channel_seq: current,
            body: `Message ${current}`,
            body_format: "markdown",
            created_at: `2026-07-19T10:00:${String(current % 60).padStart(2, "0")}.000Z`,
            thread_state: {
              root_message_id: `msg_${current}`,
              reply_count: 0,
              last_reply_author_ids: [],
            },
          },
        ],
        oldest_seq: current,
        newest_seq: current,
        has_older: true,
      });
    });
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock,
    });

    const result = await client.latestChannelMessages("chn_discussion", 1);

    expect(result.truncated).toBe(true);
    expect(result.messages).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(8);
  });

  it("replaces the authenticated bot command menu", async () => {
    const botCommand = {
      id: "botcmd_1",
      workspace_id: "wsp_1",
      bot_user_id: "usr_bot",
      command: "/status",
      description: "Show agent status",
      args_hint: "",
      created_at: "2026-07-15T00:00:00.000Z",
      updated_at: "2026-07-15T00:00:00.000Z",
    };
    const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) =>
      Response.json({ bot_commands: [botCommand] }),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const result = await client.setBotCommands([
      {
        command: "status",
        description: "Show agent status",
        args_hint: "",
      },
    ]);

    expect(result).toEqual([botCommand]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://clickclack.example/api/bots/self/commands",
      expect.objectContaining({ method: "PUT" }),
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(requestBodyJson(init)).toEqual({
      commands: [
        {
          command: "status",
          description: "Show agent status",
          args_hint: "",
        },
      ],
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("Authorization")).toBe("Bearer fake");
    expect(headers.get("Content-Type")).toBe("application/json");
  });

  it("adds paged tail queries without changing the legacy events result", async () => {
    const fetchMock = vi.fn(async () => Response.json({ events: [], tail_cursor: "cursor-900" }));
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
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
      token: "fake",
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
      token: "fake",
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
      token: "fake",
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
      token: "fake",
      fetch: fetchMock,
    });

    await expect(client.me()).rejects.toThrow(`ClickClack 502: ${streamed.expectedDetail}`);

    expect(streamed.text).not.toHaveBeenCalled();
    expect(streamed.cancel).toHaveBeenCalledTimes(1);
    expect(streamed.releaseLock).toHaveBeenCalledTimes(1);
  });

  it("redacts non-2xx response details with built-in patterns", async () => {
    const fieldA = ["access", "token"].join("_");
    const fieldB = ["client", "secret"].join("_");
    const valueA = ["redact", "fixture", "a", "123"].join("_");
    const valueB = ["redact", "fixture", "b", "123"].join("_");
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            safe: "diagnostic",
            [fieldA]: valueA,
            [fieldB]: valueB,
          }),
          { status: 502 },
        ),
    );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "test-token",
      fetch: fetchMock as unknown as typeof fetch,
    });

    let message = "";
    try {
      await client.me();
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('"safe":"diagnostic"');
    expect(message).not.toContain(valueA);
    expect(message).not.toContain(valueB);
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
      token: "fake",
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
      token: "fake",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.createChannelMessage("chn_1", "ack", { quotedMessageId: "msg_root" });

    expect(requestBodyJson(fetchMock.mock.calls[0]?.[1])).toEqual({
      body: "ack",
      quoted_message_id: "msg_root",
    });
  });

  it("serializes retry nonces and reads persisted attachments", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ message: { id: "msg_retry" } }, { status: 201 }))
      .mockResolvedValueOnce(
        Response.json({ message: { id: "msg_retry", attachments: [{ id: "upl_1" }] } }),
      );
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await client.createChannelMessage("chn_1", "retry-safe", { nonce: "media-queue-1" });
    const persisted = await client.message("msg_retry");

    expect(requestBodyJson(fetchMock.mock.calls[0]?.[1])).toEqual({
      body: "retry-safe",
      nonce: "media-queue-1",
    });
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://clickclack.example/api/messages/msg_retry",
      expect.any(Object),
    );
    expect(persisted.attachments).toEqual([{ id: "upl_1" }]);
  });

  it("uploads multipart bytes with filename and MIME, then attaches by id", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json(
          {
            upload: {
              id: "upl_1",
              workspace_id: "wsp_1",
              owner_id: "usr_1",
              filename: "viewer-proof.ts",
              content_type: "text/typescript",
              byte_size: 19,
              width: 0,
              height: 0,
              duration_ms: 0,
              created_at: "2026-07-11T00:00:00Z",
            },
          },
          { status: 201 },
        ),
      )
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock as unknown as typeof fetch,
    });

    const upload = await client.createUpload({
      workspaceId: "wsp_1",
      buffer: Buffer.from("const proof = true;"),
      filename: "viewer-proof.ts",
      contentType: "text/typescript",
      nonce: "upload-queue-1",
    });
    await client.attachUpload("msg_1", upload.id);

    const uploadRequest = fetchMock.mock.calls[0];
    expect(uploadRequest?.[0]).toBe(
      "https://clickclack.example/api/uploads?workspace_id=wsp_1&nonce=upload-queue-1",
    );
    const uploadInit = uploadRequest?.[1] as RequestInit;
    expect(uploadInit.method).toBe("POST");
    expect(uploadInit.body).toBeInstanceOf(FormData);
    const uploadHeaders = new Headers(uploadInit.headers);
    expect(uploadHeaders.get("Authorization")).toBe("Bearer fake");
    expect(uploadHeaders.has("Content-Type")).toBe(false);
    const file = (uploadInit.body as FormData).get("file");
    expect(file).toBeInstanceOf(File);
    expect((file as File).name).toBe("viewer-proof.ts");
    expect((file as File).type).toBe("text/typescript");
    expect(await (file as File).text()).toBe("const proof = true;");
    expect(fetchMock.mock.calls[1]?.[0]).toBe(
      "https://clickclack.example/api/messages/msg_1/attachments",
    );
    expect(requestBodyJson(fetchMock.mock.calls[1]?.[1])).toEqual({ upload_id: "upl_1" });
  });

  it("finds durable uploads by nonce and treats only 404 as absent", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          upload: {
            id: "upl_1",
            workspace_id: "wsp_1",
            owner_id: "usr_1",
            nonce: "upload-queue-1",
            filename: "viewer-proof.ts",
            content_type: "text/typescript",
            byte_size: 19,
            width: 0,
            height: 0,
            duration_ms: 0,
            created_at: "2026-07-11T00:00:00Z",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: "missing" },
          { status: 404, headers: { "X-ClickClack-Upload-Nonce": "supported" } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ error: "old server" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ error: "broken" }, { status: 503 }));
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.findUploadByNonce({ workspaceId: "wsp_1", nonce: "upload-queue-1" }),
    ).resolves.toEqual(expect.objectContaining({ id: "upl_1", nonce: "upload-queue-1" }));
    await expect(
      client.findUploadByNonce({ workspaceId: "wsp_1", nonce: "missing" }),
    ).resolves.toBeUndefined();
    await expect(
      client.findUploadByNonce({ workspaceId: "wsp_1", nonce: "unsupported" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("does not support durable upload nonce lookup"),
      cause: expect.objectContaining({ status: 404 }),
    });
    await expect(
      client.findUploadByNonce({ workspaceId: "wsp_1", nonce: "broken" }),
    ).rejects.toThrow("ClickClack 503");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://clickclack.example/api/uploads/by-nonce?workspace_id=wsp_1&nonce=upload-queue-1",
      "https://clickclack.example/api/uploads/by-nonce?workspace_id=wsp_1&nonce=missing",
      "https://clickclack.example/api/uploads/by-nonce?workspace_id=wsp_1&nonce=unsupported",
      "https://clickclack.example/api/uploads/by-nonce?workspace_id=wsp_1&nonce=broken",
    ]);
  });

  it("finds durable messages by nonce and distinguishes unsupported servers", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          message: {
            id: "msg_1",
            workspace_id: "wsp_1",
            author_id: "usr_1",
            thread_root_id: "msg_1",
            body: "retry-safe",
            body_format: "markdown",
            created_at: "2026-07-13T00:00:00Z",
            attachments: [{ id: "upl_1" }],
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json(
          { error: "missing" },
          { status: 404, headers: { "X-ClickClack-Message-Nonce": "supported" } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ error: "old server" }, { status: 404 }))
      .mockResolvedValueOnce(Response.json({ error: "broken" }, { status: 503 }));
    const client = createClickClackClient({
      baseUrl: "https://clickclack.example",
      token: "fake",
      fetch: fetchMock as unknown as typeof fetch,
    });

    await expect(
      client.findMessageByNonce({ workspaceId: "wsp_1", nonce: "message-queue-1" }),
    ).resolves.toEqual(
      expect.objectContaining({
        id: "msg_1",
        attachments: [{ id: "upl_1" }],
      }),
    );
    await expect(
      client.findMessageByNonce({ workspaceId: "wsp_1", nonce: "missing" }),
    ).resolves.toBeUndefined();
    await expect(
      client.findMessageByNonce({ workspaceId: "wsp_1", nonce: "unsupported" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("does not support durable message nonce lookup"),
      cause: expect.objectContaining({ status: 404 }),
    });
    await expect(
      client.findMessageByNonce({ workspaceId: "wsp_1", nonce: "broken" }),
    ).rejects.toThrow("ClickClack 503");
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual([
      "https://clickclack.example/api/messages/by-nonce?workspace_id=wsp_1&nonce=message-queue-1",
      "https://clickclack.example/api/messages/by-nonce?workspace_id=wsp_1&nonce=missing",
      "https://clickclack.example/api/messages/by-nonce?workspace_id=wsp_1&nonce=unsupported",
      "https://clickclack.example/api/messages/by-nonce?workspace_id=wsp_1&nonce=broken",
    ]);
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
      token: "fake",
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
      token: "fake",
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
      token: "fake",
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
      token: "fake",
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
      token: "fake",
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
      token: "fake",
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

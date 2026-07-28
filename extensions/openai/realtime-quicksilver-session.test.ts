import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildOpenAIQuicksilverSession,
  chunkOpenAIQuicksilverAppendText,
  createOpenAIQuicksilverBrowserSessionBroker,
  OPENAI_QUICKSILVER_OFFER_PATH,
  parseOpenAIQuicksilverEvent,
} from "./realtime-quicksilver-session.js";

class FakeSocket extends EventEmitter {
  readyState: 0 | 1 | 2 | 3 = 0;
  sent: string[] = [];
  closed = false;
  closeCode?: number;
  closeReason?: string;

  constructor(autoEvent: "open" | "error" | "close" | "manual" = "open") {
    super();
    queueMicrotask(() => {
      if (autoEvent === "open") {
        this.readyState = 1;
        this.emit("open");
      } else if (autoEvent === "error") {
        this.emit("error", new Error("transient sideband failure"));
      } else if (autoEvent === "close") {
        this.emit("close");
      }
    });
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    this.emit("close");
  }
}

function createRequest(params: {
  method?: string;
  token?: string;
  origin?: string;
  host?: string;
  contentType?: string;
  body?: string;
}): IncomingMessage {
  return Object.assign(Readable.from([params.body ?? "v=offer\r\n"]), {
    method: params.method ?? "POST",
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      ...(params.contentType === undefined
        ? { "content-type": "application/sdp" }
        : params.contentType
          ? { "content-type": params.contentType }
          : {}),
      ...(params.origin ? { origin: params.origin } : {}),
      ...(params.host ? { host: params.host } : {}),
    },
  }) as unknown as IncomingMessage;
}

function createPreflightRequest(origin: string, host?: string): IncomingMessage {
  return Object.assign(Readable.from([]), {
    method: "OPTIONS",
    headers: {
      origin,
      ...(host ? { host } : {}),
      "access-control-request-method": "POST",
      "access-control-request-headers": "authorization,content-type",
      "access-control-request-private-network": "true",
    },
  }) as unknown as IncomingMessage;
}

function createResponseHarness(): {
  res: ServerResponse;
  end: ReturnType<typeof vi.fn>;
  setHeader: ReturnType<typeof vi.fn>;
  readBody: () => string;
} {
  let body = "";
  const setHeader = vi.fn();
  const end = vi.fn((value?: string) => {
    body = value ?? "";
    queueMicrotask(() => res.emit("finish"));
  });
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    setHeader,
    end,
  }) as unknown as ServerResponse;
  return { res, end, setHeader, readBody: () => body };
}

function createCallResponse(answer = "v=answer\r\n", callId = "rtc_test"): Response {
  return new Response(answer, {
    status: 201,
    headers: { Location: `/v1/live/${callId}?source=test` },
  });
}

function parseSent(socket: FakeSocket): Array<Record<string, unknown>> {
  return socket.sent.map((payload) => JSON.parse(payload) as Record<string, unknown>);
}

function emitSideband(socket: FakeSocket, payload: unknown, isBinary = false): void {
  socket.emit("message", Buffer.from(JSON.stringify(payload)), isBinary);
}

function createBroker(params?: {
  fetchImpl?: typeof fetch;
  runAgentConsult?: (params: { prompt: string; signal?: AbortSignal }) => Promise<{ text: string }>;
  socketFactory?: (attempt: number) => FakeSocket;
}) {
  const sockets: FakeSocket[] = [];
  const socketRequests: Array<{ url: string; headers?: Record<string, string> }> = [];
  const logger = { debug: vi.fn(), warn: vi.fn() };
  const realtime = createOpenAIQuicksilverBrowserSessionBroker({
    getConfig: () => ({
      gateway: { controlUi: { allowedOrigins: ["https://control.example"] } },
    }),
    logger,
    fetchImpl: params?.fetchImpl ?? vi.fn(async () => createCallResponse()),
    webSocketFactory: (url, options) => {
      const socket = params?.socketFactory?.(sockets.length) ?? new FakeSocket();
      sockets.push(socket);
      socketRequests.push({
        url,
        headers: options.headers as Record<string, string> | undefined,
      });
      return socket;
    },
  });
  const runAgentConsult = params?.runAgentConsult ?? vi.fn(async () => ({ text: "Done" }));
  return { realtime, sockets, socketRequests, logger, runAgentConsult };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("GPT-Live session shaping", () => {
  it("maps initial roles and normalizes voices without an id field", () => {
    expect(
      buildOpenAIQuicksilverSession({
        model: "gpt-live-1",
        instructions: " Speak briefly. ",
        voice: "CEDAR",
        initialItems: [
          { role: "user", text: "Question" },
          { role: "assistant", text: "Answer" },
        ],
      }),
    ).toEqual({
      model: "gpt-live-1",
      instructions: "Speak briefly.",
      audio: { output: { voice: "cedar" } },
      delegation: { type: "client" },
      initial_items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Question" }],
        },
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer" }],
        },
      ],
    });
    expect(
      buildOpenAIQuicksilverSession({
        model: "gpt-live-1-mini",
        voice: "not-a-live-voice",
        initialItems: [],
      }),
    ).toEqual({
      model: "gpt-live-1-mini",
      instructions: "",
      audio: { output: { voice: "marin" } },
      delegation: { type: "client" },
    });
  });

  it.each([
    "alloy",
    "ash",
    "ballad",
    "cedar",
    "coral",
    "echo",
    "marin",
    "sage",
    "shimmer",
    "verse",
  ])("accepts the live-proven %s voice", (voice) => {
    expect(buildOpenAIQuicksilverSession({ model: "gpt-live-1-codex", voice }).audio).toEqual({
      output: { voice },
    });
  });

  it.each(["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"])(
    "falls back from the rejected %s voice",
    (voice) => {
      expect(buildOpenAIQuicksilverSession({ model: "gpt-live-1-codex", voice }).audio).toEqual({
        output: { voice: "marin" },
      });
    },
  );

  it("bounds initial items to the newest context", () => {
    const session = buildOpenAIQuicksilverSession({
      model: "gpt-live-1-codex",
      initialItems: Array.from({ length: 20 }, (_, index) => ({
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        text: `${index}:${"x".repeat(1_000)}`,
      })),
    });

    expect(session.initial_items).toHaveLength(10);
    expect(session.initial_items?.[0]?.content[0]?.text).toMatch(/^10:/);
    expect(session.initial_items?.at(-1)?.content[0]?.text).toMatch(/^19:/);
    expect(session.initial_items?.every((item) => item.content[0]?.text.length === 800)).toBe(true);
  });
});

describe("GPT-Live sideband protocol", () => {
  it.each(["session.updated", "output_audio.delta"])("ignores %s server-side", (type) => {
    expect(parseOpenAIQuicksilverEvent(JSON.stringify({ type }))).toEqual({
      kind: "ignored",
      eventType: type,
    });
  });

  it("parses session expiry and transcript events", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "session.started", session: { expires_at: 123 } }),
      ),
    ).toEqual({ kind: "session-started", expiresAt: 123 });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "input_transcript.added", item: { text: "hel" } }),
      ),
    ).toEqual({ kind: "transcript-delta", role: "user", text: "hel" });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "output_transcript.added", item: { text: "wor" } }),
      ),
    ).toEqual({ kind: "transcript-delta", role: "assistant", text: "wor" });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "turn.done", turn: { role: "user", transcript: "hello" } }),
      ),
    ).toEqual({ kind: "transcript-done", role: "user", text: "hello" });
  });

  it("parses client delegations and ignores non-client targets", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({
          type: "delegation.created",
          item: {
            type: "delegation",
            target: "client",
            id: "delegation-1",
            content: [
              { type: "input_text", text: "Check " },
              { type: "output_text", text: "ignored" },
              { type: "input_text", text: "the weather" },
            ],
          },
        }),
      ),
    ).toEqual({ kind: "delegation", id: "delegation-1", prompt: "Check\nthe weather" });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({
          type: "delegation.created",
          item: { type: "delegation", target: "server", id: "delegation-2", content: [] },
        }),
      ),
    ).toEqual({ kind: "ignored", eventType: "delegation.created" });
  });

  it("parses errors, reports unknown events, and rejects malformed JSON", () => {
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "error", error: { message: "call failed" } }),
      ),
    ).toEqual({ kind: "error", message: "call failed", fatalAuth: false });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({
          type: "error",
          message: "top-level failure",
          error: { message: "nested failure" },
        }),
      ),
    ).toEqual({ kind: "error", message: "top-level failure", fatalAuth: false });
    expect(
      parseOpenAIQuicksilverEvent(
        JSON.stringify({ type: "error", error: { code: "invalid_token" } }),
      ),
    ).toEqual({
      kind: "error",
      message: '{"code":"invalid_token"}',
      fatalAuth: true,
    });
    expect(parseOpenAIQuicksilverEvent(JSON.stringify({ type: "future.event" }))).toEqual({
      kind: "unknown",
      eventType: "future.event",
    });
    expect(parseOpenAIQuicksilverEvent("not-json")).toBeNull();
  });

  it("chunks appends by UTF-8 bytes without splitting characters", () => {
    const text = `${"a".repeat(499)}🙂${"b".repeat(501)}`;
    const chunks = chunkOpenAIQuicksilverAppendText(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Buffer.byteLength(chunk, "utf8")).toBeLessThanOrEqual(500);
    }
  });

  it("wraps delegated input and appends the raw speakable result", async () => {
    const runAgentConsult = vi.fn(async ({ prompt }: { prompt: string }) => ({
      text: `Result for ${prompt}`,
    }));
    const { realtime, sockets } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-1",
          runAgentConsult,
        },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      const response = createResponseHarness();
      await realtime.handler(createRequest({ token: reservation.clientSecret }), response.res);
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }
      expect(socket.sent).toEqual([]);
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "delegation.created",
            item: {
              type: "delegation",
              target: "client",
              id: "delegation-1",
              content: [
                { type: "input_text", text: "first " },
                { type: "input_text", text: "task" },
              ],
            },
          }),
        ),
        false,
      );
      await vi.waitFor(() =>
        expect(runAgentConsult).toHaveBeenCalledWith({
          prompt: "<realtime_delegation>\n  <input>first\ntask</input>\n</realtime_delegation>",
          signal: expect.any(AbortSignal),
        }),
      );
      await vi.waitFor(() =>
        expect(parseSent(socket)).toContainEqual({
          type: "delegation.context.append",
          delegation_item_id: "delegation-1",
          channel: "speakable",
          content: [
            {
              type: "input_text",
              text: "Result for <realtime_delegation>\n  <input>first\ntask</input>\n</realtime_delegation>",
            },
          ],
        }),
      );
      await realtime.cleanup();
      expect(parseSent(socket).at(-1)).toEqual({ type: "session.close" });
      expect(socket.closed).toBe(true);
    } finally {
      await realtime.cleanup();
    }
  });

  it("adds the in-call transcript delta to each delegation and resets it", async () => {
    const runAgentConsult = vi.fn(async (_params: { prompt: string; signal?: AbortSignal }) => ({
      text: "Done",
    }));
    const { realtime, sockets } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1-codex", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }

      emitSideband(socket, { type: "input_transcript.added", item: { text: "hel" } });
      emitSideband(socket, {
        type: "turn.done",
        turn: { role: "user", transcript: "hello" },
      });
      emitSideband(socket, { type: "output_transcript.added", item: { text: "ack" } });
      emitSideband(socket, {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegation-1",
          content: [{ type: "input_text", text: "check weather" }],
        },
      });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(1));
      expect(runAgentConsult.mock.calls[0]?.[0]?.prompt).toBe(
        "<realtime_delegation>\n  <input>check weather</input>\n  <transcript_delta>user: hello\nassistant: ack</transcript_delta>\n</realtime_delegation>",
      );

      emitSideband(socket, {
        type: "turn.done",
        turn: { role: "user", transcript: "second context" },
      });
      emitSideband(socket, {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "delegation-2",
          content: [{ type: "input_text", text: "next task" }],
        },
      });
      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledTimes(2));
      expect(runAgentConsult.mock.calls[1]?.[0]?.prompt).toBe(
        "<realtime_delegation>\n  <input>next task</input>\n  <transcript_delta>user: second context</transcript_delta>\n</realtime_delegation>",
      );
    } finally {
      await realtime.cleanup();
    }
  });

  it("aborts the in-flight consult when a newer delegation arrives", async () => {
    const signals: AbortSignal[] = [];
    const resolutions: Array<(value: { text: string }) => void> = [];
    const runAgentConsult = vi.fn(
      ({ signal }: { prompt: string; signal?: AbortSignal }) =>
        new Promise<{ text: string }>((resolve) => {
          if (signal) {
            signals.push(signal);
          }
          resolutions.push(resolve);
        }),
    );
    const { realtime, sockets } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1-codex", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }

      for (const [id, text] of [
        ["delegation-1", "first"],
        ["delegation-2", "second"],
      ] as const) {
        emitSideband(socket, {
          type: "delegation.created",
          item: {
            type: "delegation",
            target: "client",
            id,
            content: [{ type: "input_text", text }],
          },
        });
        await vi.waitFor(() =>
          expect(runAgentConsult).toHaveBeenCalledTimes(id.endsWith("1") ? 1 : 2),
        );
      }

      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      resolutions[0]?.({ text: "stale" });
      resolutions[1]?.({ text: "fresh" });
      await vi.waitFor(() =>
        expect(parseSent(socket)).toContainEqual(
          expect.objectContaining({
            delegation_item_id: "delegation-2",
            channel: "speakable",
          }),
        ),
      );
      expect(parseSent(socket)).not.toContainEqual(
        expect.objectContaining({ delegation_item_id: "delegation-1" }),
      );
    } finally {
      await realtime.cleanup();
    }
  });

  it("skips empty delegations", async () => {
    const runAgentConsult = vi.fn(async () => ({ text: "Done" }));
    const { realtime, sockets } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1-codex", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }
      emitSideband(socket, {
        type: "delegation.created",
        item: {
          type: "delegation",
          target: "client",
          id: "empty",
          content: [{ type: "input_text", text: "  " }],
        },
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(runAgentConsult).not.toHaveBeenCalled();
    } finally {
      await realtime.cleanup();
    }
  });

  it("returns a speakable failure when the delegated agent fails", async () => {
    const runAgentConsult = vi.fn(async () => {
      throw new Error("workspace unavailable");
    });
    const { realtime, sockets, logger } = createBroker({ runAgentConsult });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }
      socket.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "delegation.created",
            item: {
              type: "delegation",
              target: "client",
              id: "delegation-failed",
              content: [{ type: "input_text", text: "do work" }],
            },
          }),
        ),
        false,
      );
      await vi.waitFor(() => {
        expect(parseSent(socket)).toContainEqual(
          expect.objectContaining({
            type: "delegation.context.append",
            delegation_item_id: "delegation-failed",
            channel: "speakable",
            content: [
              {
                type: "input_text",
                text: "The agent task failed. Tell the user it did not complete and offer to try again.",
              },
            ],
          }),
        );
      });
      // The raw failure detail must stay in Gateway logs, never on the provider sideband.
      expect(JSON.stringify(parseSent(socket))).not.toContain("workspace unavailable");
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("workspace unavailable"));
    } finally {
      await realtime.cleanup();
    }
  });
});

describe("GPT-Live offer broker", () => {
  it.each([
    {
      name: "OAuth",
      auth: { type: "oauth" as const, token: "oauth-token", accountId: "account-123" },
      authorization: "Bearer oauth-token",
      accountId: "account-123",
    },
    {
      name: "API key",
      auth: { type: "api-key" as const, token: "platform-key" },
      authorization: "Bearer platform-key",
      accountId: undefined,
    },
  ])("uses matching $name headers on signaling and the API sideband", async (authCase) => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.7.2-test");
    let signalingUrl: string | undefined;
    let signalingHeaders: Record<string, string> | undefined;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      signalingUrl = typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
      signalingHeaders = init?.headers as Record<string, string> | undefined;
      return createCallResponse("v=answer\r\n", "rtc_header-parity");
    }) as unknown as typeof fetch;
    const { realtime, socketRequests } = createBroker({ fetchImpl });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-1",
          runAgentConsult: vi.fn(async () => ({ text: "Done" })),
        },
        authCase.auth,
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );

      const sideband = socketRequests[0];
      expect(signalingUrl).toBe("https://api.openai.com/v1/live");
      expect(signalingUrl).not.toContain("?");
      expect(sideband?.url).toBe("wss://api.openai.com/v1/live/rtc_header-parity");
      expect(signalingHeaders).toMatchObject({
        Authorization: authCase.authorization,
        "OpenAI-Alpha": "quicksilver=v2",
        "User-Agent": "openclaw/2026.7.2-test",
        originator: "openclaw",
        version: "2026.7.2-test",
        "session-id": expect.any(String),
        "thread-id": expect.any(String),
        "x-session-id": expect.any(String),
        "Content-Type": expect.stringMatching(/^multipart\/form-data; boundary=/),
      });
      expect(sideband?.headers).toMatchObject({
        Authorization: authCase.authorization,
        "OpenAI-Alpha": "quicksilver=v2",
        "User-Agent": "openclaw/2026.7.2-test",
        originator: "openclaw",
        version: "2026.7.2-test",
        "session-id": signalingHeaders?.["session-id"],
        "thread-id": signalingHeaders?.["thread-id"],
        "x-session-id": signalingHeaders?.["x-session-id"],
      });
      expect(signalingHeaders?.["session-id"]).not.toBe(signalingHeaders?.["x-session-id"]);
      expect(signalingHeaders?.["thread-id"]).not.toBe(signalingHeaders?.["x-session-id"]);
      expect(signalingHeaders?.["thread-id"]).not.toBe(signalingHeaders?.["session-id"]);
      if (authCase.accountId) {
        expect(signalingHeaders?.["chatgpt-account-id"]).toBe(authCase.accountId);
        expect(sideband?.headers?.["chatgpt-account-id"]).toBe(authCase.accountId);
      } else {
        expect(signalingHeaders).not.toHaveProperty("chatgpt-account-id");
        expect(sideband?.headers).not.toHaveProperty("chatgpt-account-id");
      }
    } finally {
      await realtime.cleanup();
    }
  });

  it("survives a connecting socket that errors during retry teardown", async () => {
    // Regression: ws emits `error` asynchronously when a CONNECTING socket is closed.
    // Without a retained listener that is an unhandled EventEmitter error and kills the
    // Gateway process, so the retry must keep swallowing errors on discarded sockets.
    class ErrorOnCloseSocket extends FakeSocket {
      constructor() {
        super("manual");
      }
      override close(code?: number, reason?: string): void {
        queueMicrotask(() => this.emit("error", new Error("socket hang up")));
        super.close(code, reason);
      }
    }
    const { realtime, sockets } = createBroker({
      socketFactory: (attempt) => (attempt < 1 ? new ErrorOnCloseSocket() : new FakeSocket("open")),
    });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-1-codex",
          runAgentConsult: vi.fn(async () => ({ text: "Done" })),
        },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      const response = createResponseHarness();
      await realtime.handler(createRequest({ token: reservation.clientSecret }), response.res);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(response.res.statusCode).toBe(200);
      expect(sockets[0]?.listenerCount("error")).toBeGreaterThan(0);
    } finally {
      await realtime.cleanup();
    }
  });

  it("retries transient sideband startup failures", async () => {
    const { realtime, sockets } = createBroker({
      socketFactory: (attempt) => new FakeSocket(attempt < 2 ? "error" : "open"),
    });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-1-codex",
          runAgentConsult: vi.fn(async () => ({ text: "Done" })),
        },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      const response = createResponseHarness();
      await realtime.handler(createRequest({ token: reservation.clientSecret }), response.res);

      expect(response.res.statusCode).toBe(200);
      expect(sockets).toHaveLength(3);
      expect(sockets[0]?.closeCode).toBe(1000);
      expect(sockets[1]?.closeCode).toBe(1000);
      expect(sockets[2]?.readyState).toBe(1);
    } finally {
      await realtime.cleanup();
    }
  });

  it("buffers sideband messages that arrive with the open handshake", async () => {
    const runAgentConsult = vi.fn(async () => ({ text: "Done" }));
    const { realtime, sockets } = createBroker({
      runAgentConsult,
      socketFactory: () => {
        const socket = new FakeSocket("manual");
        queueMicrotask(() => {
          emitSideband(socket, {
            type: "delegation.created",
            item: {
              type: "delegation",
              target: "client",
              id: "early-delegation",
              content: [{ type: "input_text", text: "early task" }],
            },
          });
          socket.readyState = 1;
          socket.emit("open");
        });
        return socket;
      },
    });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1-codex", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );

      await vi.waitFor(() => expect(runAgentConsult).toHaveBeenCalledOnce());
      expect(sockets).toHaveLength(1);
    } finally {
      await realtime.cleanup();
    }
  });

  it("keeps nonfatal error frames alive but closes on fatal auth errors", async () => {
    const { realtime, sockets, logger } = createBroker();
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-1-codex",
          runAgentConsult: vi.fn(async () => ({ text: "Done" })),
        },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }

      emitSideband(socket, { type: "error", message: "recoverable turn failure" });
      expect(socket.closed).toBe(false);
      emitSideband(socket, { type: "error", error: { code: "invalid_token" } });
      expect(socket.closed).toBe(true);
      expect(socket.closeCode).toBe(1000);
      expect(logger.warn).toHaveBeenCalledTimes(2);
    } finally {
      await realtime.cleanup();
    }
  });

  it("treats binary sideband frames as protocol failures", async () => {
    const { realtime, sockets, logger } = createBroker();
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-1-codex",
          runAgentConsult: vi.fn(async () => ({ text: "Done" })),
        },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      await realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        createResponseHarness().res,
      );
      const socket = sockets[0];
      if (!socket) {
        throw new Error("Expected sideband socket");
      }

      emitSideband(socket, { binary: true }, true);
      expect(socket.closed).toBe(true);
      expect(logger.warn).toHaveBeenCalledWith(
        "OpenAI GPT-Live sideband returned an unexpected binary frame",
      );
    } finally {
      await realtime.cleanup();
    }
  });

  it("uses a relative single-use offer route and enforces CORS", async () => {
    const { realtime } = createBroker();
    try {
      const accepted = createResponseHarness();
      await realtime.handler(createPreflightRequest("https://control.example"), accepted.res);
      expect(accepted.res.statusCode).toBe(204);
      expect(accepted.setHeader).toHaveBeenCalledWith(
        "Access-Control-Allow-Origin",
        "https://control.example",
      );
      expect(accepted.setHeader).toHaveBeenCalledWith(
        "Access-Control-Allow-Private-Network",
        "true",
      );

      const privateOrigin = "http://192.168.1.24:18789";
      const privatePreflight = createResponseHarness();
      await realtime.handler(
        createPreflightRequest(privateOrigin, "192.168.1.24:18789"),
        privatePreflight.res,
      );
      expect(privatePreflight.res.statusCode).toBe(204);
      expect(privatePreflight.setHeader).toHaveBeenCalledWith(
        "Access-Control-Allow-Origin",
        privateOrigin,
      );

      const privatePost = createResponseHarness();
      await realtime.handler(
        createRequest({
          token: "invalid",
          origin: privateOrigin,
          host: "192.168.1.24:18789",
        }),
        privatePost.res,
      );
      expect(privatePost.res.statusCode).toBe(401);
      expect(privatePost.setHeader).toHaveBeenCalledWith(
        "Access-Control-Allow-Origin",
        privateOrigin,
      );

      const rejected = createResponseHarness();
      await realtime.handler(
        createPreflightRequest("https://untrusted.example", "192.168.1.24:18789"),
        rejected.res,
      );
      expect(rejected.res.statusCode).toBe(403);

      const rejectedPost = createResponseHarness();
      await realtime.handler(
        createRequest({
          token: "invalid",
          origin: "https://untrusted.example",
          host: "192.168.1.24:18789",
        }),
        rejectedPost.res,
      );
      expect(rejectedPost.res.statusCode).toBe(403);

      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-1",
          voice: "invalid",
          runAgentConsult: vi.fn(async () => ({ text: "Done" })),
        },
        { type: "api-key", token: "platform-key" },
      );
      expect(reservation).toMatchObject({
        offerUrl: OPENAI_QUICKSILVER_OFFER_PATH,
        model: "gpt-live-1",
        voice: "marin",
        expiresAt: expect.any(Number),
      });
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      const first = createResponseHarness();
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, origin: "https://control.example" }),
        first.res,
      );
      expect(first.res.statusCode).toBe(200);
      expect(first.readBody()).toBe("v=answer\r\n");

      const replay = createResponseHarness();
      await realtime.handler(createRequest({ token: reservation.clientSecret }), replay.res);
      expect(replay.res.statusCode).toBe(401);
    } finally {
      await realtime.cleanup();
    }
  });

  it("rejects expired tokens, unsupported methods, and content types", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    const { realtime } = createBroker();
    try {
      const method = createResponseHarness();
      await realtime.handler(createRequest({ method: "GET" }), method.res);
      expect(method.res.statusCode).toBe(405);

      const contentType = createResponseHarness();
      await realtime.handler(createRequest({ contentType: "application/json" }), contentType.res);
      expect(contentType.res.statusCode).toBe(415);

      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-live-1",
          runAgentConsult: vi.fn(async () => ({ text: "Done" })),
        },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      now.mockReturnValue(61_001);
      const expired = createResponseHarness();
      await realtime.handler(createRequest({ token: reservation.clientSecret }), expired.res);
      expect(expired.res.statusCode).toBe(401);
    } finally {
      await realtime.cleanup();
    }
  });

  it("caps pending and active sessions", async () => {
    const { realtime } = createBroker();
    const runAgentConsult = vi.fn(async () => ({ text: "Done" }));
    try {
      await Promise.all(
        Array.from({ length: 8 }, () =>
          realtime.broker.createBrowserSession(
            { providerConfig: {}, model: "gpt-live-1", runAgentConsult },
            { type: "api-key", token: "platform-key" },
          ),
        ),
      );
      await expect(
        realtime.broker.createBrowserSession(
          { providerConfig: {}, model: "gpt-live-1", runAgentConsult },
          { type: "api-key", token: "platform-key" },
        ),
      ).rejects.toThrow("Too many concurrent OpenAI GPT-Live sessions");
    } finally {
      await realtime.cleanup();
    }
  });

  it("releases a reservation after an empty SDP offer", async () => {
    const { realtime } = createBroker();
    const runAgentConsult = vi.fn(async () => ({ text: "Done" }));
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      const response = createResponseHarness();
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, body: "   " }),
        response.res,
      );
      expect(response.res.statusCode).toBe(400);

      await expect(
        Promise.all(
          Array.from({ length: 8 }, () =>
            realtime.broker.createBrowserSession(
              { providerConfig: {}, model: "gpt-live-1", runAgentConsult },
              { type: "api-key", token: "platform-key" },
            ),
          ),
        ),
      ).resolves.toHaveLength(8);
    } finally {
      await realtime.cleanup();
    }
  });

  it("aborts a redeemed offer when its browser session is canceled", async () => {
    let upstreamSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
        await new Promise<Response>((_resolve, reject) => {
          upstreamSignal = init?.signal ?? undefined;
          const rejectAbort = () => {
            const reason = upstreamSignal?.reason;
            reject(reason instanceof Error ? reason : new Error("aborted"));
          };
          upstreamSignal?.addEventListener("abort", rejectAbort, { once: true });
          if (upstreamSignal?.aborted) {
            rejectAbort();
          }
        }),
    ) as unknown as typeof fetch;
    const { realtime, sockets } = createBroker({ fetchImpl });
    const runAgentConsult = vi.fn(async () => ({ text: "Done" }));
    try {
      const reservation = await realtime.broker.createBrowserSession(
        { providerConfig: {}, model: "gpt-live-1", runAgentConsult },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      const response = createResponseHarness();
      const handling = realtime.handler(
        createRequest({ token: reservation.clientSecret }),
        response.res,
      );
      await vi.waitFor(() => expect(upstreamSignal).toBeDefined());

      realtime.broker.cancelBrowserSession(reservation);

      await expect(handling).resolves.toBe(true);
      expect(upstreamSignal?.aborted).toBe(true);
      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).toContain("GPT-Live session canceled");
      expect(response.end).toHaveBeenCalledOnce();
      expect(sockets).toEqual([]);
    } finally {
      await realtime.cleanup();
    }
  });
});

import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPENAI_QUICKSILVER_OFFER_PATH } from "./realtime-quicksilver-session.js";
import { buildOpenAIQuicksilverSession } from "./realtime-quicksilver-wire.js";
import {
  FakeSocket,
  createRequest,
  createPreflightRequest,
  createResponseHarness,
  createCallResponse,
  emitSideband,
  createBroker,
} from "./realtime-quicksilver.test-helpers.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

function requestTarget(url: string | URL | Request): string {
  return typeof url === "string" ? url : url instanceof URL ? url.href : url.url;
}

function requireStringBody(body: BodyInit | null | undefined): string {
  if (typeof body !== "string") {
    throw new Error("Expected string request body");
  }
  return body;
}

const AUDIO_ONLY_SDP = "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n";

describe("GPT-Live session shaping", () => {
  it("maps initial roles and normalizes voices without an id field", () => {
    expect(
      buildOpenAIQuicksilverSession({
        model: "gpt-live-1",
        instructions: " Speak briefly. ",
        voice: "SPRUCE",
        initialItems: [
          { role: "user", text: "Question" },
          { role: "assistant", text: "Answer" },
        ],
      }),
    ).toEqual({
      model: "gpt-live-1",
      instructions: "Speak briefly.",
      audio: { output: { voice: "spruce" } },
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
      audio: { output: { voice: "cove" } },
      delegation: { type: "client" },
    });
  });

  it.each(["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"])(
    "accepts the Codex V3 %s voice",
    (voice) => {
      expect(buildOpenAIQuicksilverSession({ model: "gpt-live-1-codex", voice }).audio).toEqual({
        output: { voice },
      });
    },
  );

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
  ])("defaults the GA-only %s voice to Cove for GPT-Live", (voice) => {
    expect(buildOpenAIQuicksilverSession({ model: "gpt-live-1-codex", voice }).audio).toEqual({
      output: { voice: "cove" },
    });
  });

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

describe("GPT-Live offer broker", () => {
  it("waits for the GA sideband before returning an audio-only SDP answer and hangs up once", async () => {
    let releaseSideband!: () => void;
    const sidebandReady = new Promise<void>((resolve) => {
      releaseSideband = resolve;
    });
    const bridge = {
      connect: vi.fn(async () => await sidebandReady),
      close: vi.fn(),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      isConnected: vi.fn(() => true),
    } satisfies RealtimeVoiceBridge;
    const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const target = requestTarget(url);
      if (target.endsWith("/hangup")) {
        return new Response(null, { status: 204 });
      }
      expect(target).toBe("https://api.openai.com/v1/realtime/calls");
      const form = requireStringBody(init?.body);
      expect(form).toContain("m=audio 9 UDP/TLS/RTP/SAVPF 111");
      expect(form).not.toContain("m=application");
      return new Response("v=ga-answer\r\n", {
        status: 201,
        headers: { Location: "/v1/realtime/calls/rtc_gateway" },
      });
    });
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const { realtime, logger } = createBroker({ fetchImpl });
    let terminateSideband: (() => void) | undefined;
    const createBridge = vi.fn((params: { onTerminal: () => void }) => {
      terminateSideband = params.onTerminal;
      return bridge;
    });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-realtime-2.1",
          gatewayControl: { bindBridge: vi.fn() },
          gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
          clientControl: { owner: "gateway" },
          gaSideband: {
            createBridge,
          },
        },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      expect(reservation).not.toHaveProperty("model");
      expect(reservation).not.toHaveProperty("voice");
      expect(reservation.offerResponseMaxBytes).toBe(256 * 1024);
      const response = createResponseHarness();
      const handling = realtime.handler(
        createRequest({
          token: reservation.clientSecret,
          body: "v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n",
        }),
        response.res,
      );
      await vi.waitFor(() => expect(bridge.connect).toHaveBeenCalledOnce());
      expect(response.end).not.toHaveBeenCalled();
      expect(createBridge).toHaveBeenCalledWith({
        apiKey: "platform-key",
        callId: "rtc_gateway",
        onTerminal: expect.any(Function),
      });
      releaseSideband();
      await expect(handling).resolves.toBe(true);
      expect(response.res.statusCode).toBe(201);
      expect(response.readBody()).toBe("v=ga-answer\r\n");
      expect(logger.debug).toHaveBeenCalledWith(
        expect.stringMatching(
          /^OpenAI Realtime sideband offer ready \{"callCreateMs":\d+,"sidebandReadyMs":\d+,"totalOfferMs":\d+\}$/,
        ),
      );

      terminateSideband?.();
      await vi.waitFor(() =>
        expect(
          fetchMock.mock.calls.filter(([url]) =>
            requestTarget(url).endsWith("/rtc_gateway/hangup"),
          ),
        ).toHaveLength(1),
      );
      await realtime.broker.cancelBrowserSession(reservation);
      expect(bridge.close).toHaveBeenCalledOnce();
      expect(
        fetchMock.mock.calls.filter(([url]) => requestTarget(url).endsWith("/rtc_gateway/hangup")),
      ).toHaveLength(1);
    } finally {
      releaseSideband();
      await realtime.cleanup();
    }
  });

  it.each([
    ["error", "sideband unavailable"],
    ["timeout", "OpenAI realtime connection timeout"],
  ])("hangs up a GA call when sideband startup ends in %s", async (failure, message) => {
    const bridge = {
      connect: vi.fn(async () => {
        throw new Error(message);
      }),
      close: vi.fn(),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      isConnected: vi.fn(() => false),
    } satisfies RealtimeVoiceBridge;
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      requestTarget(url).endsWith("/hangup")
        ? new Response(null, { status: 204 })
        : new Response("v=answer\r\n", {
            status: 201,
            headers: { Location: `/v1/realtime/calls/rtc_${failure}` },
          }),
    );
    const fetchImpl = fetchMock as unknown as typeof fetch;
    const { realtime } = createBroker({ fetchImpl });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-realtime-2.1",
          gatewayControl: { bindBridge: vi.fn() },
          gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
          clientControl: { owner: "gateway" },
          gaSideband: {
            createBridge: () => bridge,
          },
        },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      const response = createResponseHarness();
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, body: AUDIO_ONLY_SDP }),
        response.res,
      );
      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).toContain(message);
      expect(bridge.close).toHaveBeenCalledOnce();
      expect(
        fetchMock.mock.calls.filter(([url]) =>
          requestTarget(url).endsWith(`/rtc_${failure}/hangup`),
        ),
      ).toHaveLength(1);
    } finally {
      await realtime.cleanup();
    }
  });

  it("hangs up when the GA answer is not delivered to the client", async () => {
    const bridge = {
      connect: vi.fn(async () => undefined),
      close: vi.fn(),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      isConnected: vi.fn(() => true),
    } satisfies RealtimeVoiceBridge;
    const fetchMock = vi.fn(async (url: string | URL | Request) =>
      requestTarget(url).endsWith("/hangup")
        ? new Response(null, { status: 204 })
        : new Response("v=answer\r\n", {
            status: 201,
            headers: { Location: "/v1/realtime/calls/rtc_delivery" },
          }),
    );
    const { realtime } = createBroker({ fetchImpl: fetchMock as unknown as typeof fetch });
    try {
      const reservation = await realtime.broker.createBrowserSession(
        {
          providerConfig: {},
          model: "gpt-realtime-2.1",
          gatewayControl: { bindBridge: vi.fn() },
          gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
          clientControl: { owner: "gateway" },
          gaSideband: {
            createBridge: () => bridge,
          },
        },
        { type: "api-key", token: "platform-key" },
      );
      if (reservation.transport !== "webrtc") {
        throw new Error("Expected WebRTC reservation");
      }
      const response = createResponseHarness();
      response.end.mockImplementationOnce(() => {
        queueMicrotask(() => response.res.emit("close"));
      });
      await realtime.handler(
        createRequest({ token: reservation.clientSecret, body: AUDIO_ONLY_SDP }),
        response.res,
      );

      expect(bridge.close).toHaveBeenCalledOnce();
      expect(
        fetchMock.mock.calls.filter(([url]) => requestTarget(url).endsWith("/rtc_delivery/hangup")),
      ).toHaveLength(1);
    } finally {
      await realtime.cleanup();
    }
  });

  it.each([
    [
      "active data channel",
      `${AUDIO_ONLY_SDP}m=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n`,
      "application media",
    ],
    ["video", `${AUDIO_ONLY_SDP}m=video 9 UDP/TLS/RTP/SAVPF 96\r\n`, "video media"],
    ["no active audio", "v=0\r\nm=audio 0 UDP/TLS/RTP/SAVPF 111\r\n", "active audio"],
    ["oversized line", `${AUDIO_ONLY_SDP}a=${"x".repeat(4_097)}\r\n`, "line is too large"],
  ])(
    "rejects a bounded GA sideband SDP with %s before provider creation",
    async (_name, body, message) => {
      const fetchImpl = vi.fn();
      const { realtime } = createBroker({ fetchImpl: fetchImpl as unknown as typeof fetch });
      try {
        const reservation = await realtime.broker.createBrowserSession(
          {
            providerConfig: {},
            model: "gpt-realtime-2.1",
            gatewayControl: { bindBridge: vi.fn() },
            gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
            clientControl: { owner: "gateway" },
            gaSideband: {
              createBridge: vi.fn(),
            },
          },
          { type: "api-key", token: "platform-key" },
        );
        if (reservation.transport !== "webrtc") {
          throw new Error("Expected WebRTC reservation");
        }
        const response = createResponseHarness();
        await realtime.handler(
          createRequest({ token: reservation.clientSecret, body }),
          response.res,
        );
        expect(response.res.statusCode).toBe(400);
        expect(response.readBody()).toContain(message);
        expect(fetchImpl).not.toHaveBeenCalled();
      } finally {
        await realtime.cleanup();
      }
    },
  );

  it.each([
    {
      name: "OAuth",
      auth: { type: "oauth" as const, token: "oauth-token", accountId: "account-123" },
      authorization: "Bearer oauth-token",
      accountId: "account-123",
      callUrl:
        "https://chatgpt.com/backend-api/codex/realtime/calls?intent=quicksilver&architecture=avas",
      contentType: "application/json",
    },
    {
      name: "API key",
      auth: { type: "api-key" as const, token: "platform-key" },
      authorization: "Bearer platform-key",
      accountId: undefined,
      callUrl: "https://api.openai.com/v1/live",
      contentType: expect.stringMatching(/^multipart\/form-data; boundary=/),
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
      expect(signalingUrl).toBe(authCase.callUrl);
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
        "Content-Type": authCase.contentType,
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
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });

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

  it.each(["error", "close"] as const)(
    "fails safely when the sideband emits %s immediately after opening",
    async (terminalEvent) => {
      const onError = vi.fn();
      const onClose = vi.fn();
      const { realtime, sockets, logger } = createBroker({
        socketFactory: () => {
          const socket = new FakeSocket("manual");
          queueMicrotask(() => {
            socket.readyState = 1;
            socket.emit("open");
            if (terminalEvent === "error") {
              socket.emit("error", new Error("post-open failure"));
            } else {
              socket.readyState = 3;
              socket.emit("close");
            }
          });
          return socket;
        },
      });
      try {
        const reservation = await realtime.broker.createBrowserSession(
          {
            providerConfig: {},
            model: "gpt-live-1-codex",
            runAgentConsult: vi.fn(async () => ({ text: "Done" })),
            gatewayControl: { bindBridge: vi.fn(), onError, onClose },
          },
          { type: "api-key", token: "platform-key" },
        );
        if (reservation.transport !== "webrtc") {
          throw new Error("Expected WebRTC reservation");
        }
        const response = createResponseHarness();
        await realtime.handler(createRequest({ token: reservation.clientSecret }), response.res);

        expect(response.res.statusCode).toBe(502);
        expect(response.readBody()).toContain("sideband failed during startup");
        expect(sockets).toHaveLength(1);
        expect(onError).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledExactlyOnceWith("error");
        if (terminalEvent === "error") {
          expect(logger.warn).toHaveBeenCalledWith(
            "OpenAI GPT-Live sideband socket failed: post-open failure",
          );
        }
      } finally {
        await realtime.cleanup();
      }
    },
  );

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
        voice: "cove",
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
      const contentTypePrefix = createResponseHarness();
      await realtime.handler(
        createRequest({ contentType: "application/sdp+json" }),
        contentTypePrefix.res,
      );
      expect(contentTypePrefix.res.statusCode).toBe(415);

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

  it.each([false, true])(
    "expires an unused Gateway-control offer despite a throwing callback (%s)",
    async (throwingCallback) => {
      vi.useFakeTimers();
      const { realtime } = createBroker();
      const onClose = vi.fn(() => {
        if (throwingCallback) {
          throw new Error("close callback failed");
        }
      });
      try {
        const reservation = await realtime.broker.createBrowserSession(
          {
            providerConfig: {},
            model: "gpt-realtime-2.1",
            gatewayControl: { bindBridge: vi.fn(), onClose },
            gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
            clientControl: { owner: "gateway" },
            gaSideband: {
              createBridge: vi.fn(),
            },
          },
          { type: "api-key", token: "platform-key" },
        );
        if (reservation.transport !== "webrtc") {
          throw new Error("Expected WebRTC reservation");
        }

        const expiryError = await vi.advanceTimersByTimeAsync(60_000).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect.soft(expiryError).toBeUndefined();
        expect(onClose).toHaveBeenCalledOnce();
        expect(onClose).toHaveBeenCalledWith("completed");
        const expired = createResponseHarness();
        await realtime.handler(createRequest({ token: reservation.clientSecret }), expired.res);
        expect(expired.res.statusCode).toBe(401);
      } finally {
        await realtime.cleanup();
        vi.useRealTimers();
      }
    },
  );

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

  it("caps reservations per owning Gateway connection", async () => {
    const { realtime } = createBroker();
    const gaRequest = (ownerConnId: string) => ({
      providerConfig: {},
      model: "gpt-realtime-2.1",
      ownerConnId,
      gatewayControl: { bindBridge: vi.fn() },
      gaSession: { type: "realtime" as const, model: "gpt-realtime-2.1" },
      clientControl: { owner: "gateway" as const },
      gaSideband: {
        createBridge: vi.fn(),
      },
    });
    try {
      await Promise.all(
        Array.from({ length: 2 }, () =>
          realtime.broker.createBrowserSession(gaRequest("conn-1"), {
            type: "api-key",
            token: "platform-key",
          }),
        ),
      );
      await expect(
        realtime.broker.createBrowserSession(gaRequest("conn-1"), {
          type: "api-key",
          token: "platform-key",
        }),
      ).rejects.toThrow("Too many concurrent OpenAI realtime sessions for this client");
      await expect(
        realtime.broker.createBrowserSession(gaRequest("conn-2"), {
          type: "api-key",
          token: "platform-key",
        }),
      ).resolves.toMatchObject({ transport: "webrtc" });
    } finally {
      await realtime.cleanup();
    }
  });

  it("does not apply the GA sideband owner quota to browser-owned GA sessions", async () => {
    const { realtime } = createBroker();
    try {
      await expect(
        Promise.all(
          Array.from({ length: 3 }, () =>
            realtime.broker.createBrowserSession(
              {
                providerConfig: {},
                model: "gpt-realtime-2.1",
                ownerConnId: "conn-browser",
                gaSession: { type: "realtime", model: "gpt-realtime-2.1" },
              },
              { type: "api-key", token: "platform-key" },
            ),
          ),
        ),
      ).resolves.toHaveLength(3);
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

      await realtime.broker.cancelBrowserSession(reservation);

      await expect(handling).resolves.toBe(true);
      expect(upstreamSignal?.aborted).toBe(true);
      expect(response.res.statusCode).toBe(502);
      expect(response.readBody()).toContain("OpenAI realtime session canceled");
      expect(response.end).toHaveBeenCalledOnce();
      expect(sockets).toEqual([]);
    } finally {
      await realtime.cleanup();
    }
  });
});

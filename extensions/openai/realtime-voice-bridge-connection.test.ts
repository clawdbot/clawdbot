// Openai tests cover realtime voice provider plugin behavior.
import { REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ } from "openclaw/plugin-sdk/realtime-voice";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceGatewayControl,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildOpenAIRealtimeVoiceProvider } from "./realtime-voice-provider.js";

const mocks = await vi.hoisted(async () => {
  const { createOpenAIRealtimeMockState } = await import("./realtime-voice-test-support.js");
  return createOpenAIRealtimeMockState();
});
const { FakeWebSocket, fetchWithSsrFGuardMock } = mocks;

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: mocks.execFileSyncMock,
  };
});

vi.mock("ws", () => ({
  default: mocks.FakeWebSocket,
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: mocks.fetchWithSsrFGuardMock,
}));

vi.mock("openclaw/plugin-sdk/provider-auth", () => ({
  isProviderAuthProfileConfigured: mocks.isProviderAuthProfileConfiguredMock,
  resolveProviderAuthProfileApiKey: mocks.resolveProviderAuthProfileApiKeyMock,
}));
import { createOpenAIRealtimeTestSupport } from "./realtime-voice-test-support.js";

const {
  parseSent,
  createNativeBridge,
  requireSocket,
  beginBridgeConnection,
  openSocket,
  emitServerEvent,
  emitSessionUpdated,
  connectReadyBridge,
  expectedResponseCreateEvent,
  requireRecord,
  requireNestedRecord,
  expectRecordFields,
  requireSession,
  createRealtimeTool,
  createUnreadableToolName,
  createMalformedToolName,
  resetTestState,
  restoreTestEnvironment,
  readInternalRealtimeVoiceProviderApi,
  createQuicksilverBrowserBrokerFixture,
} = createOpenAIRealtimeTestSupport({ ...mocks, buildOpenAIRealtimeVoiceProvider });

describe("OpenAI realtime voice bridge connection", () => {
  beforeEach(() => {
    resetTestState();
  });

  afterEach(() => {
    restoreTestEnvironment();
  });

  it("adds OpenClaw attribution headers to native realtime websocket requests", () => {
    vi.stubEnv("OPENCLAW_VERSION", "2026.3.22");
    const provider = buildOpenAIRealtimeVoiceProvider();
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "test-api-key-test" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });

    void bridge.connect();
    bridge.close();

    const socket = FakeWebSocket.instances[0];
    const options = socket?.args[1] as
      | { headers?: Record<string, string>; maxPayload?: number }
      | undefined;
    expectRecordFields(options?.headers, "websocket headers", {
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
    expect(options?.headers).not.toHaveProperty("OpenAI-Beta");
    expect(options?.maxPayload).toBe(16 * 1024 * 1024);
  });

  it.each([
    { binding: "modern", throwingCloseCallback: false },
    { binding: "modern", throwingCloseCallback: true },
    { binding: "v2026.8.1", throwingCloseCallback: false },
    { binding: "v2026.8.1", throwingCloseCallback: true },
  ] as const)(
    "shares GA policy and retires the $binding binding with throwing callback=$throwingCloseCallback",
    async ({ binding, throwingCloseCallback }) => {
      const { broker, createBrowserSession } = createQuicksilverBrowserBrokerFixture({
        session: { clientSecret: "gateway-token" },
      });
      const provider = buildOpenAIRealtimeVoiceProvider({
        quicksilverBrowserSessionBroker: broker,
      });
      const bindBridge = vi.fn();
      const bindControl = vi.fn<NonNullable<RealtimeVoiceGatewayControl["bindControl"]>>();
      const onEvent = vi.fn();
      const onReady = vi.fn();
      const onClose = vi.fn(() => {
        if (throwingCloseCallback) {
          throw new Error("close callback failed");
        }
      });
      const onTerminal = vi.fn();
      const cfg = {} as never;

      expect(
        readInternalRealtimeVoiceProviderApi(provider).resolveBrowserSessionCapabilities({
          cfg,
          providerConfig: { apiKey: "test-api-key-platform" },
          model: "gpt-realtime-2.1",
        }),
      ).toMatchObject({ supportsGatewayControl: true });
      await expect(
        provider.createBrowserSession?.({
          cfg,
          providerConfig: { apiKey: "test-api-key-platform" },
          instructions: "Stay concise.",
          model: "gpt-realtime-2.1",
          prefixPaddingMs: 420,
          reasoningEffort: "medium",
          silenceDurationMs: 650,
          tools: [createRealtimeTool("openclaw_agent_consult")],
          vadThreshold: 0.7,
          voice: "marin",
          gatewayControl: {
            bindBridge,
            onEvent,
            onReady,
            onClose,
            ...(binding === "modern" ? { bindControl } : {}),
          },
        }),
      ).resolves.toMatchObject({
        clientSecret: "gateway-token",
        offerUrl: "/plugins/openai/realtime/calls",
      });
      const brokerRequest = requireRecord(
        createBrowserSession.mock.calls[0]?.[0],
        "broker request",
      );
      expect(brokerRequest.clientControl).toEqual({ owner: "gateway" });
      expect(createBrowserSession.mock.calls[0]?.[1]).toEqual({
        type: "api-key",
        token: "test-api-key-platform",
      });
      const gaSideband = requireRecord(brokerRequest.gaSideband, "GA sideband request");
      const gaSession = requireRecord(brokerRequest.gaSession, "GA session policy");
      expect(gaSession).toMatchObject({
        type: "realtime",
        instructions: "Stay concise.",
        model: "gpt-realtime-2.1",
        output_modalities: ["audio"],
        reasoning: { effort: "medium" },
        tool_choice: "auto",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            noise_reduction: { type: "near_field" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.7,
              prefix_padding_ms: 420,
              silence_duration_ms: 650,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: { format: { type: "audio/pcm", rate: 24000 }, voice: "marin" },
        },
      });
      const createBridge = gaSideband.createBridge as (params: {
        apiKey: string;
        callId: string;
        onTerminal: () => void;
      }) => RealtimeVoiceBridge;
      const bridge = createBridge({
        apiKey: "test-api-key-platform",
        callId: "rtc_gateway",
        onTerminal,
      });
      if (binding === "modern") {
        expect(bindControl).toHaveBeenCalledOnce();
        expect(bindBridge).not.toHaveBeenCalled();
      } else {
        expect(bindBridge).toHaveBeenCalledWith(bridge);
        expect(bindControl).not.toHaveBeenCalled();
      }
      const { connecting, socket } = beginBridgeConnection(bridge);
      let connectResolved = false;
      void connecting.then(() => {
        connectResolved = true;
      });
      expect(socket.args[0]).toBe("wss://api.openai.com/v1/realtime?call_id=rtc_gateway");
      openSocket(socket);
      await Promise.resolve();
      const sessionUpdates = parseSent(socket).filter((event) => event.type === "session.update");
      expect(sessionUpdates).toHaveLength(1);
      expect(sessionUpdates[0]?.session).toEqual(gaSession);
      emitServerEvent(socket, {
        type: "session.created",
        session: { type: "realtime", tools: [{ type: "function" }], tool_choice: "auto" },
      });
      await Promise.resolve();
      expect(connectResolved).toBe(false);
      expect(onReady).not.toHaveBeenCalled();
      expect(parseSent(socket).filter((event) => event.type === "session.update")).toHaveLength(1);
      emitSessionUpdated(socket);
      await connecting;
      expect(connectResolved).toBe(true);
      expect(onReady).toHaveBeenCalledOnce();
      expect(onEvent).toHaveBeenCalledWith({
        direction: "server",
        type: "session.created",
        detail: "tools=1 toolChoice=auto",
      });

      bridge.setMediaTimestamp(1_000);
      emitServerEvent(socket, {
        type: "response.output_audio.delta",
        item_id: "item_pcm",
        delta: Buffer.alloc(3_700 * 48).toString("base64"),
      });
      bridge.setMediaTimestamp(4_760);
      bridge.handleBargeIn?.({ audioPlaybackActive: true });

      expect(parseSent(socket).slice(-2)).toEqual([
        {
          type: "response.cancel",
          event_id: expect.stringMatching(/^openclaw-response-cancel-/),
        },
        {
          type: "conversation.item.truncate",
          item_id: "item_pcm",
          content_index: 0,
          audio_end_ms: 3_700,
        },
      ]);
      if (binding === "modern") {
        const control = bindControl.mock.calls[0]?.[0];
        if (!control?.sendUserMessage || !control.submitToolResult) {
          throw new Error("Expected both GA control operations");
        }
        await control.submitToolResult("unknown-call", {});
        control.sendUserMessage("Read the current status");
        expect(parseSent(socket)).toContainEqual({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "Read the current status" }],
          },
        });
      }
      if (throwingCloseCallback) {
        expect(() => bridge.close()).toThrow("close callback failed");
      } else {
        bridge.close();
      }
      expect(onClose).toHaveBeenCalledOnce();
      expect(onTerminal).toHaveBeenCalledOnce();
      expect(fetchWithSsrFGuardMock).not.toHaveBeenCalled();
    },
  );

  it("waits for session.updated before draining audio and firing onReady", async () => {
    const onReady = vi.fn();
    const bridge = createNativeBridge({
      instructions: "Be helpful.",
      language: "de",
      onReady,
    });
    const { connecting, socket } = beginBridgeConnection(bridge);
    let connectResolved = false;
    void connecting.then(() => {
      connectResolved = true;
    });

    openSocket(socket);
    await Promise.resolve();

    bridge.sendAudio(Buffer.from("before-ready"));
    emitServerEvent(socket, { type: "session.created" });

    expect(connectResolved).toBe(false);
    expect(onReady).not.toHaveBeenCalled();
    expect(parseSent(socket).map((event) => event.type)).toEqual(["session.update"]);
    const session = requireSession(socket);
    expectRecordFields(session, "session", {
      type: "realtime",
      model: "gpt-realtime-2.1",
      output_modalities: ["audio"],
    });
    const inputAudio = requireNestedRecord(session, ["audio", "input"]);
    expectRecordFields(inputAudio, "session audio input", {
      format: { type: "audio/pcmu" },
      noise_reduction: null,
      transcription: { model: "gpt-4o-mini-transcribe", language: "de" },
    });
    expect(requireNestedRecord(session, ["audio", "output"])).toEqual({
      format: { type: "audio/pcmu" },
      voice: "alloy",
    });
    expect(session).not.toHaveProperty("temperature");
    expect(bridge.isConnected()).toBe(false);

    emitSessionUpdated(socket);
    await connecting;

    expect(connectResolved).toBe(true);
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(parseSent(socket).map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
    ]);
    expect(bridge.isConnected()).toBe(true);
  });

  it("bounds queued audio by aggregate bytes before session readiness", async () => {
    const bridge = createNativeBridge();
    const { connecting, socket } = beginBridgeConnection(bridge);
    openSocket(socket);
    await Promise.resolve();

    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x01));
    bridge.sendAudio(Buffer.alloc(512 * 1024, 0x02));
    bridge.sendAudio(Buffer.from("overflow"));
    emitSessionUpdated(socket);
    await connecting;

    const audioEvents = parseSent(socket).filter(
      (event) => event.type === "input_audio_buffer.append",
    );
    expect(audioEvents).toHaveLength(2);
    expect(
      audioEvents.map((event) => Buffer.from(String(event.audio), "base64").byteLength),
    ).toEqual([512 * 1024, Buffer.byteLength("overflow")]);
    bridge.close();
  });

  it("drops stalled input audio and rate-limits aggregate warnings", async () => {
    vi.useFakeTimers();
    try {
      const logger = { debug: vi.fn(), warn: vi.fn() };
      const provider = buildOpenAIRealtimeVoiceProvider({ logger });
      const bridge = provider.createBridge({
        providerConfig: { apiKey: "test-api-key-test" },
        onAudio: vi.fn(),
        onClearAudio: vi.fn(),
      });
      const { connecting, socket } = beginBridgeConnection(bridge);
      openSocket(socket);
      emitSessionUpdated(socket);
      await connecting;
      socket.bufferedAmount = 1024 * 1024 + 1;

      bridge.sendAudio(Buffer.from("first"));
      await vi.advanceTimersByTimeAsync(4_000);
      bridge.sendAudio(Buffer.from("second"));
      await vi.advanceTimersByTimeAsync(1_000);
      bridge.sendAudio(Buffer.from("third"));

      expect(
        parseSent(socket).filter((event) => event.type === "input_audio_buffer.append"),
      ).toHaveLength(0);
      expect(logger.warn).toHaveBeenNthCalledWith(
        1,
        "OpenAI realtime input audio backpressure; droppedFrames=1",
      );
      expect(logger.warn).toHaveBeenNthCalledWith(
        2,
        "OpenAI realtime input audio backpressure; droppedFrames=2",
      );
      bridge.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes readiness-drained audio through websocket backpressure", async () => {
    const logger = { debug: vi.fn(), warn: vi.fn() };
    const provider = buildOpenAIRealtimeVoiceProvider({ logger });
    const bridge = provider.createBridge({
      providerConfig: { apiKey: "test-api-key-test" },
      onAudio: vi.fn(),
      onClearAudio: vi.fn(),
    });
    const { connecting, socket } = beginBridgeConnection(bridge);
    openSocket(socket);
    bridge.sendAudio(Buffer.from("queued-before-ready"));
    socket.bufferedAmount = 1024 * 1024 + 1;
    emitSessionUpdated(socket);
    await connecting;

    expect(
      parseSent(socket).filter((event) => event.type === "input_audio_buffer.append"),
    ).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      "OpenAI realtime input audio backpressure; droppedFrames=1",
    );
    bridge.close();
  });

  it("discards audio closed before the first connection and reconnects fresh", async () => {
    const onClose = vi.fn();
    const bridge = createNativeBridge({ onClose });

    bridge.sendAudio(Buffer.from("queued-before-connect"));
    bridge.close();
    bridge.close();
    bridge.sendAudio(Buffer.from("sent-after-close"));

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();

    const { connecting, socket } = beginBridgeConnection(bridge);
    openSocket(socket);
    emitSessionUpdated(socket);
    await connecting;

    expect(
      parseSent(socket).filter((event) => event.type === "input_audio_buffer.append"),
    ).toHaveLength(0);

    bridge.close();
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
  });

  it("does not carry queued audio across terminal close and explicit reconnect", async () => {
    const bridge = createNativeBridge();
    const { connecting: firstConnect, socket: firstSocket } = beginBridgeConnection(bridge);
    openSocket(firstSocket);
    await Promise.resolve();

    bridge.sendAudio(Buffer.from("queued-before-close"));
    bridge.close();
    await firstConnect;
    bridge.sendAudio(Buffer.from("sent-after-close"));

    const { connecting: reconnecting, socket: secondSocket } = beginBridgeConnection(bridge, 1);
    openSocket(secondSocket);
    emitSessionUpdated(secondSocket);
    await reconnecting;

    expect(
      parseSent(secondSocket).filter((event) => event.type === "input_audio_buffer.append"),
    ).toHaveLength(0);
    bridge.close();
  });

  it("shares an in-flight connection until session readiness", async () => {
    const onReady = vi.fn();
    const bridge = createNativeBridge({ onReady });
    const firstConnect = bridge.connect();
    const secondConnect = bridge.connect();
    const socket = requireSocket();

    expect(FakeWebSocket.instances).toHaveLength(1);
    openSocket(socket);
    emitSessionUpdated(socket);

    await Promise.all([firstConnect, secondConnect]);
    expect(onReady).toHaveBeenCalledOnce();
    bridge.close();
  });

  it("fails terminally when the readiness callback throws", async () => {
    vi.useFakeTimers();
    const readyError = new Error("readiness callback failed");
    const onClose = vi.fn();
    const onError = vi.fn();
    const onReady = vi.fn(() => {
      throw readyError;
    });
    const bridge = createNativeBridge({ onClose, onError, onReady });
    const { connecting, socket } = beginBridgeConnection(bridge);
    let connectError: unknown;
    const observedConnect = connecting.catch((error: unknown) => {
      connectError = error;
    });

    openSocket(socket);
    bridge.sendAudio(Buffer.from("queued-before-ready"));
    emitSessionUpdated(socket);
    await vi.advanceTimersByTimeAsync(0);
    const immediateConnectError = connectError;

    bridge.close();
    await observedConnect;

    expect(immediateConnectError).toBe(readyError);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(readyError);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("error");
    expect(socket.closed).toBe(true);
    expect(bridge.isConnected()).toBe(false);
    expect(
      parseSent(socket).filter((event) => event.type === "input_audio_buffer.append"),
    ).toHaveLength(0);

    emitSessionUpdated(socket);
    await expect(bridge.connect()).rejects.toBe(readyError);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(onReady).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("omits unsupported OpenAI tool names from GA session updates", async () => {
    const bridge = createNativeBridge({
      tools: [
        createRealtimeTool("1_lookup"),
        createRealtimeTool("calendar.lookup:next"),
        createRealtimeTool("bad/name"),
        createRealtimeTool("x".repeat(65)),
        createMalformedToolName(null),
        createMalformedToolName(42),
        createUnreadableToolName(),
      ],
    });
    const { connecting, socket } = beginBridgeConnection(bridge);

    openSocket(socket);

    const tools = requireSession(socket).tools as Array<{ name?: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["1_lookup", "x".repeat(65)]);
    emitSessionUpdated(socket);
    await connecting;
  });

  it("keeps Azure deployment bridges on deployment-compatible session payloads", async () => {
    const bridge = createNativeBridge({
      providerConfig: {
        apiKey: "test-api-key-test",
        azureEndpoint: "https://example.openai.azure.com/",
        azureDeployment: "realtime-prod",
        azureApiVersion: "2024-10-01-preview",
        voice: "verse",
      },
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions: "Be helpful.",
      tools: [
        createRealtimeTool("1_lookup"),
        createRealtimeTool("calendar.lookup:next"),
        createRealtimeTool("x".repeat(65)),
      ],
    });
    const { connecting, socket } = beginBridgeConnection(bridge);

    expect(socket.args[0]).toBe(
      "wss://example.openai.azure.com/openai/realtime?api-version=2024-10-01-preview&deployment=realtime-prod",
    );

    openSocket(socket);
    await Promise.resolve();

    const session = requireSession(socket);
    expectRecordFields(session, "session", {
      modalities: ["text", "audio"],
      instructions: "Be helpful.",
      voice: "verse",
      input_audio_format: "pcm16",
      output_audio_format: "pcm16",
      input_audio_transcription: { model: "whisper-1" },
      temperature: 0.8,
    });
    expectRecordFields(
      requireRecord(session.turn_detection, "session turn detection"),
      "turn detection",
      {
        create_response: true,
      },
    );
    expect(session).not.toHaveProperty("type");
    expect(session).not.toHaveProperty("audio");
    const tools = session.tools as Array<{ name?: string }>;
    expect(tools.map((tool) => tool.name)).toEqual(["1_lookup"]);

    emitSessionUpdated(socket);
    await connecting;

    bridge.triggerGreeting?.("Say hello.");
    expect(parseSent(socket).slice(-2)).toEqual([
      {
        type: "session.update",
        session: {
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: false,
          },
        },
      },
      expectedResponseCreateEvent(),
    ]);

    emitServerEvent(socket, { type: "response.done" });
    expect(parseSent(socket).at(-1)).toEqual({
      type: "session.update",
      session: {
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
          create_response: true,
        },
      },
    });
  });

  it("rejects connection when session configuration fails before readiness", async () => {
    const bridge = createNativeBridge();
    const { connecting, socket } = beginBridgeConnection(bridge);

    openSocket(socket);
    emitServerEvent(socket, {
      type: "error",
      error: { message: "invalid realtime session" },
    });

    await expect(connecting).rejects.toThrow("invalid realtime session");
    expect(bridge.isConnected()).toBe(false);
  });

  it("rejects connection when the socket closes before session readiness", async () => {
    const bridge = createNativeBridge();
    const { connecting, socket } = beginBridgeConnection(bridge);

    openSocket(socket);
    socket.close(1006, "session closed");

    await expect(connecting).rejects.toThrow("OpenAI realtime connection closed before ready");
    expect(bridge.isConnected()).toBe(false);
  });

  it("bounds sideband frames received before session readiness", async () => {
    const bridge = createNativeBridge();
    const { connecting, socket } = beginBridgeConnection(bridge);
    openSocket(socket);
    const frame = Buffer.from(
      JSON.stringify({ type: "session.created", padding: "x".repeat(600 * 1024) }),
    );

    socket.emit("message", frame);
    socket.emit("message", frame);

    await expect(connecting).rejects.toThrow("sideband startup buffer exceeded");
    expect(bridge.isConnected()).toBe(false);
  });

  it("does not report startup timeout shutdown as a clean close", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const bridge = createNativeBridge({ onClose });
    const { connecting, socket } = beginBridgeConnection(bridge);

    const timeoutAssertion = expect(connecting).rejects.toThrow(
      "OpenAI realtime connection timeout",
    );
    await vi.advanceTimersByTimeAsync(10_000);
    await timeoutAssertion;
    expect(socket.terminated).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(bridge.isConnected()).toBe(false);
  });

  it.each([
    {
      $name: "automatic audio turn responses disabled",
      autoRespondToAudio: false,
      interruptResponseOnInputAudio: false,
      expectedCreateResponse: false,
      expectedInterruptResponse: false,
    },
    {
      $name: "realtime response interruption disabled",
      autoRespondToAudio: true,
      interruptResponseOnInputAudio: false,
      expectedCreateResponse: true,
      expectedInterruptResponse: false,
    },
  ])(
    "$name",
    async ({
      autoRespondToAudio,
      interruptResponseOnInputAudio,
      expectedCreateResponse,
      expectedInterruptResponse,
    }) => {
      const bridge = createNativeBridge({
        autoRespondToAudio,
        interruptResponseOnInputAudio,
      });
      const socket = await connectReadyBridge(bridge);

      expectRecordFields(
        requireNestedRecord(requireSession(socket), ["audio", "input", "turn_detection"]),
        "turn detection",
        {
          create_response: expectedCreateResponse,
          interrupt_response: expectedInterruptResponse,
        },
      );
    },
  );

  it("can request PCM16 24 kHz realtime audio for Chrome command-pair bridges", async () => {
    const bridge = createNativeBridge({
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
    });
    const socket = await connectReadyBridge(bridge);

    const session = requireSession(socket);
    expect(requireNestedRecord(session, ["audio", "input", "format"])).toEqual({
      type: "audio/pcm",
      rate: 24000,
    });
    expect(requireNestedRecord(session, ["audio", "output", "format"])).toEqual({
      type: "audio/pcm",
      rate: 24000,
    });
  });

  it("settles cleanly when closed before the websocket opens", async () => {
    const onClose = vi.fn();
    const bridge = createNativeBridge({ onClose });
    const { connecting, socket } = beginBridgeConnection(bridge);

    bridge.close();
    bridge.close();

    await expect(connecting).resolves.toBeUndefined();
    expect(socket.closed).toBe(true);
    expect(socket.terminated).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledWith("completed");
  });
});

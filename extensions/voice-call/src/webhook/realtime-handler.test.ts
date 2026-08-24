// Voice Call tests cover realtime handler plugin behavior.
import http from "node:http";
import { expectDefined } from "@openclaw/normalization-core";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceSessionHarness,
  RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "../websocket-test-support.js";
import { RealtimeAudioPacer } from "./realtime-audio-pacer.js";
import { RealtimeCallHandler } from "./realtime-handler.js";
import { StreamDisconnectGrace } from "./stream-disconnect-grace.js";

const realtimeVoiceHarnessTestHooks = vi.hoisted(() => ({
  onCreate: undefined as ((harness: RealtimeVoiceSessionHarness) => void) | undefined,
}));

vi.mock("openclaw/plugin-sdk/realtime-voice", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/realtime-voice")>();
  return {
    ...actual,
    createRealtimeVoiceSessionHarness: (
      params: Parameters<typeof actual.createRealtimeVoiceSessionHarness>[0],
    ) => {
      const harness = actual.createRealtimeVoiceSessionHarness(params);
      realtimeVoiceHarnessTestHooks.onCreate?.(harness);
      return harness;
    },
  };
});

afterEach(() => {
  realtimeVoiceHarnessTestHooks.onCreate = undefined;
  vi.useRealTimers();
});

function makeRequest(url: string, host = "gateway.ts.net"): http.IncomingMessage {
  const req = new http.IncomingMessage(null as never);
  req.url = url;
  req.method = "POST";
  req.headers = host ? { host } : {};
  return req;
}

function makeBridge(overrides: Partial<RealtimeVoiceBridge> = {}): RealtimeVoiceBridge {
  return {
    connect: async () => {},
    sendAudio: () => {},
    setMediaTimestamp: () => {},
    submitToolResult: vi.fn(),
    acknowledgeMark: () => {},
    close: () => {},
    isConnected: () => true,
    triggerGreeting: () => {},
    ...overrides,
  };
}

function makeRealtimeProvider(
  createBridge: RealtimeVoiceProviderPlugin["createBridge"],
  overrides: Partial<RealtimeVoiceProviderPlugin> = {},
): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge,
    ...overrides,
  };
}

const PROVIDER_BARGE_IN_CAPABILITIES = {
  transports: ["gateway-relay"],
  inputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
  outputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
  supportsBargeIn: true,
  handlesInputAudioBargeIn: true,
} satisfies NonNullable<RealtimeVoiceProviderPlugin["capabilities"]>;

const PROVIDER_WITH_LOCAL_BARGE_IN_CAPABILITIES = {
  transports: ["gateway-relay"],
  inputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
  outputAudioFormats: [{ encoding: "g711_ulaw", sampleRateHz: 8000, channels: 1 }],
  supportsBargeIn: true,
} satisfies NonNullable<RealtimeVoiceProviderPlugin["capabilities"]>;

function makeCallRegistrationResolver(params: {
  provider: RealtimeVoiceProviderPlugin;
  providerConfig: Record<string, unknown>;
  instructions: string;
  resolveInstructions?: (call: CallRecord) => string;
}) {
  return (call: CallRecord) => ({
    agentId: call.agentId ?? "main",
    provider: params.provider,
    providerConfig: params.providerConfig,
    instructions: params.resolveInstructions?.(call) ?? params.instructions,
  });
}

function makeHandler(
  overrides?: Partial<VoiceCallRealtimeConfig>,
  deps?: {
    manager?: Partial<CallManager>;
    providerConfig?: Record<string, unknown>;
    realtimeProvider?: RealtimeVoiceProviderPlugin;
    resolveInstructions?: (call: CallRecord) => string;
    streamDisconnectLifecycle?: {
      connect: (providerCallId: string, streamId: string) => void;
      disconnect: (providerCallId: string, streamId: string) => void;
      retire: (providerCallId: string, streamId: string) => void;
    };
  },
) {
  const config: VoiceCallRealtimeConfig = {
    enabled: true,
    streamPath: overrides?.streamPath ?? "/voice/stream/realtime",
    instructions: overrides?.instructions ?? "Be helpful.",
    toolPolicy: overrides?.toolPolicy ?? "safe-read-only",
    consultPolicy: overrides?.consultPolicy ?? "auto",
    tools: overrides?.tools ?? [],
    fastContext: overrides?.fastContext ?? {
      enabled: false,
      timeoutMs: 800,
      maxResults: 3,
      sources: ["memory", "sessions"],
      fallbackToConsult: false,
    },
    agentContext: overrides?.agentContext ?? {
      enabled: false,
      maxChars: 6000,
      includeIdentity: true,
      includeWorkspaceFiles: true,
      files: ["SOUL.md", "IDENTITY.md", "USER.md"],
    },
    providers: overrides?.providers ?? {},
    ...(overrides?.provider ? { provider: overrides.provider } : {}),
  };
  const realtimeProvider = deps?.realtimeProvider ?? makeRealtimeProvider(() => makeBridge());
  const providerConfig = deps?.providerConfig ?? { apiKey: "test-key" };
  return new RealtimeCallHandler(
    config,
    {
      processEvent: vi.fn(),
      endCall: vi.fn(async () => ({ success: true })),
      getCall: vi.fn(),
      getCallByProviderCallId: vi.fn(),
      ...deps?.manager,
    } as unknown as CallManager,
    makeCallRegistrationResolver({
      provider: realtimeProvider,
      providerConfig,
      instructions: config.instructions,
      resolveInstructions: deps?.resolveInstructions,
    }),
    "/voice/webhook",
    deps?.streamDisconnectLifecycle ?? {
      connect: () => {},
      disconnect: () => {},
      retire: () => {},
    },
    undefined,
  );
}

const startRealtimeServer = async (
  handler: RealtimeCallHandler,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook"));
  const match = payload.body.match(/wss:\/\/[^/]+(\/[^"]+)/);
  if (!match) {
    throw new Error("Failed to extract realtime stream path");
  }

  return await startUpgradeWsServer({
    urlPath: expectDefined(match[1], "realtime stream path"),
    onUpgrade: (request, socket, head) => {
      handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
};

const startStreamSessionServer = async (
  handler: RealtimeCallHandler,
  streamUrl: string,
): Promise<{
  url: string;
  close: () => Promise<void>;
}> => {
  return await startUpgradeWsServer({
    urlPath: new URL(streamUrl).pathname,
    onUpgrade: (request, socket, head) => {
      handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
};

async function waitForRealtimeTest(
  callback: () => void | Promise<void>,
  options: { timeout?: number; interval?: number } = {},
) {
  await vi.waitFor(callback, { interval: 1, ...options });
}

function requireFirstMockCall(calls: readonly unknown[][], label: string): unknown[] {
  const call = calls.at(0);
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

type RealtimeBridgeRequest = Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];
type RecentTalkEvent = { turnId?: string; type: string };

function makeCallRecord(providerCallId: string): CallRecord {
  return {
    callId: "call-1",
    providerCallId,
    provider: "twilio",
    direction: "inbound",
    state: "ringing",
    from: "+15550001234",
    to: "+15550009999",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    metadata: {},
  };
}

function createFinalizingStreamGrace(
  processEvent: (event: NormalizedEvent) => void,
  eventId: string,
) {
  return new StreamDisconnectGrace(({ providerCallId }) => {
    processEvent({
      id: eventId,
      type: "call.ended",
      callId: "call-1",
      providerCallId,
      timestamp: Date.now(),
      reason: "completed",
    });
  });
}

function parseWebSocketMessage(data: RawData): Record<string, unknown> {
  const bytes = Buffer.isBuffer(data)
    ? data
    : Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.from(data);
  return JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
}

async function withBargeInHarness(
  params: {
    bridgeHandlesInputAudioBargeIn?: boolean;
    handlesProviderBargeIn?: boolean;
    interruptResponseOnInputAudio?: boolean;
    providerCallId: string;
  },
  run: (harness: {
    callbacks: RealtimeBridgeRequest;
    call: CallRecord;
    createBridge: ReturnType<typeof vi.fn>;
    handleBargeIn: ReturnType<typeof vi.fn>;
    outboundMessages: Array<Record<string, unknown>>;
    processEvent: ReturnType<typeof vi.fn>;
    sendAudio: ReturnType<typeof vi.fn>;
    ws: WebSocket;
  }) => Promise<void>,
): Promise<void> {
  let callbacks: RealtimeBridgeRequest | undefined;
  const sendAudio = vi.fn();
  const handleBargeIn = vi.fn();
  const processEvent = vi.fn();
  const call = makeCallRecord(params.providerCallId);
  const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
    callbacks = request;
    return makeBridge({
      handleBargeIn,
      sendAudio,
      ...(params.bridgeHandlesInputAudioBargeIn === undefined
        ? {}
        : { handlesInputAudioBargeIn: params.bridgeHandlesInputAudioBargeIn }),
    });
  });
  const capabilities = params.handlesProviderBargeIn
    ? PROVIDER_BARGE_IN_CAPABILITIES
    : PROVIDER_WITH_LOCAL_BARGE_IN_CAPABILITIES;
  const handler = makeHandler(undefined, {
    manager: {
      getCallByProviderCallId: vi.fn((): CallRecord => call),
      processEvent,
    },
    providerConfig: {
      apiKey: "test-key",
      ...(params.interruptResponseOnInputAudio === undefined
        ? {}
        : { interruptResponseOnInputAudio: params.interruptResponseOnInputAudio }),
    },
    realtimeProvider: makeRealtimeProvider(createBridge, {
      capabilities,
      id: params.handlesProviderBargeIn ? "openai" : "test",
    }),
  });
  const server = await startRealtimeServer(handler);

  try {
    const ws = await connectWs(server.url);
    const outboundMessages: Array<Record<string, unknown>> = [];
    ws.on("message", (data) => outboundMessages.push(parseWebSocketMessage(data)));
    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: `MZ-${params.providerCallId}`, callSid: params.providerCallId },
        }),
      );
      await waitForRealtimeTest(() => expect(createBridge).toHaveBeenCalled());
      if (!callbacks) {
        throw new Error("expected realtime bridge callbacks");
      }
      await run({
        callbacks,
        call,
        createBridge,
        handleBargeIn,
        outboundMessages,
        processEvent,
        sendAudio,
        ws,
      });
    } finally {
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close();
      }
    }
  } finally {
    await server.close();
  }
}

function recentTalkEvents(call: CallRecord): RecentTalkEvent[] {
  return (call.metadata?.recentTalkEvents as RecentTalkEvent[] | undefined) ?? [];
}

function requireCancelledTurn(call: CallRecord): RecentTalkEvent & { turnId: string } {
  const cancelled = recentTalkEvents(call).find((event) => event.type === "turn.cancelled");
  if (!cancelled?.turnId) {
    throw new Error("expected barge-in to cancel the active turn");
  }
  return cancelled as RecentTalkEvent & { turnId: string };
}

describe("RealtimeCallHandler path routing", () => {
  it.each([
    [{ status: "completed" as const, responseId: "response-1" }, "turn.ended"],
    [
      { status: "failed" as const, responseId: "response-1", message: "provider failed" },
      "turn.ended",
    ],
    [
      {
        status: "incomplete" as const,
        responseId: "response-1",
        reason: "max_output_tokens",
        message: "provider response incomplete",
      },
      "turn.ended",
    ],
    [
      { status: "cancelled" as const, responseId: "response-1", reason: "client_cancelled" },
      "turn.cancelled",
    ],
  ])("finishes each telephony turn without closing the call", async (outcome, terminalType) => {
    await withBargeInHarness(
      { providerCallId: `CA-response-${outcome.status}` },
      async ({ callbacks, call, ws }) => {
        callbacks.onTranscript?.("user", "first turn", true);
        callbacks.onAudio(Buffer.from([1]));
        callbacks.onResponseDone?.(outcome);
        callbacks.onEvent?.({
          direction: "server",
          responseId: outcome.responseId,
          type: "response.done",
        });

        const firstEvents = recentTalkEvents(call);
        expect(firstEvents.filter((event) => event.type === terminalType)).toHaveLength(1);
        expect(firstEvents.filter((event) => event.type === "output.audio.done")).toHaveLength(1);
        expect(firstEvents.filter((event) => event.type === "session.error")).toHaveLength(
          outcome.status === "failed" || outcome.status === "incomplete" ? 1 : 0,
        );
        expect(ws.readyState).toBe(WebSocket.OPEN);

        callbacks.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });
        callbacks.onTranscript?.("user", "later turn", true);
        callbacks.onAudio(Buffer.from([2]));
        callbacks.onResponseDone?.({ status: "completed", responseId: "response-2" });
        callbacks.onEvent?.({
          direction: "server",
          responseId: "response-2",
          type: "response.done",
        });

        const finalEvents = recentTalkEvents(call);
        expect(
          finalEvents.filter(
            (event) => event.type === "turn.ended" || event.type === "turn.cancelled",
          ),
        ).toHaveLength(2);
        expect(finalEvents.filter((event) => event.type === "output.audio.done")).toHaveLength(2);
        expect(ws.readyState).toBe(WebSocket.OPEN);
      },
    );
  });

  it("uses the request host and stream path in TwiML", () => {
    const handler = makeHandler();
    const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook", "gateway.ts.net"));

    expect(payload.statusCode).toBe(200);
    expect(payload.body).toMatch(
      /wss:\/\/gateway\.ts\.net\/voice\/stream\/realtime\/[0-9a-f-]{36}/,
    );
  });

  it("preserves a public path prefix ahead of serve.path", () => {
    const handler = makeHandler({ streamPath: "/custom/stream/realtime" });
    handler.setPublicUrl("https://public.example:8443/api/voice/webhook");
    const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook", "127.0.0.1:3334"));

    expect(handler.getStreamPathPattern()).toBe("/api/custom/stream/realtime");
    expect(payload.body).toMatch(
      /wss:\/\/public\.example:8443\/api\/custom\/stream\/realtime\/[0-9a-f-]{36}/,
    );
  });

  it("normalizes Twilio outbound realtime directions", async () => {
    let callbacks:
      | {
          onReady?: () => void;
        }
      | undefined;
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return makeBridge();
      },
    );
    const processEvent = vi.fn();
    const getCallByProviderCallId = vi.fn(
      (): CallRecord => ({
        callId: "call-1",
        providerCallId: "CA-outbound",
        provider: "twilio",
        direction: "outbound",
        state: "ringing",
        from: "+15550001234",
        to: "+15550009999",
        startedAt: Date.now(),
        transcript: [],
        processedEventIds: [],
        metadata: {},
      }),
    );
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const payload = handler.buildTwiMLPayload(
      makeRequest("/voice/webhook"),
      new URLSearchParams({
        Direction: "outbound-dial",
        From: "+15550001234",
        To: "+15550009999",
      }),
    );
    const match = payload.body.match(/wss:\/\/[^/]+(\/[^"]+)/);
    if (!match) {
      throw new Error("Failed to extract realtime stream path");
    }
    const server = await startUpgradeWsServer({
      urlPath: expectDefined(match[1], "realtime stream path"),
      onUpgrade: (request, socket, head) => {
        handler.handleWebSocketUpgrade(request, socket, head);
      },
    });

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-outbound", callSid: "CA-outbound" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });
        callbacks?.onReady?.();
        const event = requireFirstMockCall(processEvent.mock.calls, "processed event")[0] as
          | NormalizedEvent
          | undefined;
        expect(event?.type).toBe("call.initiated");
        if (event?.type !== "call.initiated") {
          throw new Error("expected outbound realtime stream to emit call.initiated");
        }
        expect(event.direction).toBe("outbound");
        expect(event.from).toBe("+15550001234");
        expect(event.to).toBe("+15550009999");
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("joins Telnyx realtime streams to the token-bound call", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const processEvent = vi.fn();
    const resolveInstructions = vi.fn((call: CallRecord) => `instructions:${call.agentId}`);
    const getCall = vi.fn(
      (): CallRecord => ({
        callId: "call-1",
        agentId: "support",
        providerCallId: "v3:call-1",
        provider: "telnyx",
        direction: "inbound",
        state: "answered",
        from: "+15550001234",
        to: "+15550009999",
        startedAt: Date.now(),
        transcript: [],
        processedEventIds: [],
        metadata: { initialMessage: "hello" },
      }),
    );
    const triggerGreeting = vi.fn();
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge({ triggerGreeting });
    });
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCall,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
      resolveInstructions,
    });
    handler.setPublicUrl("https://public.example/voice/webhook");
    const session = handler.issueStreamSession({
      providerName: "telnyx",
      callId: "call-1",
      from: "+15550001234",
      to: "+15550009999",
      direction: "inbound",
    });
    const server = await startStreamSessionServer(handler, session.streamUrl);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            stream_id: "stream-1",
            start: { call_control_id: "v3:call-1" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        const eventTypes = processEvent.mock.calls.map(
          ([event]) => (event as NormalizedEvent).type,
        );
        expect(eventTypes).toEqual(["call.answered"]);
        expect((processEvent.mock.calls[0]?.[0] as NormalizedEvent | undefined)?.callId).toBe(
          "call-1",
        );
        expect(resolveInstructions).toHaveBeenCalledWith(
          expect.objectContaining({
            callId: "call-1",
            agentId: "support",
          }),
        );
        expect(createBridge.mock.calls[0]?.[0].instructions).toBe("instructions:support");
        expect(createBridge.mock.calls[0]?.[0].agentId).toBe("support");
        callbacks?.onReady?.();
        expect(triggerGreeting).toHaveBeenCalledTimes(1);
        expect(triggerGreeting.mock.calls[0]?.[0]).toContain("hello");
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("rejects stream sessions when token expiry would exceed the Date range", async () => {
    const processEvent = vi.fn();
    const createBridge = vi.fn(() => makeBridge());
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    handler.setPublicUrl("https://public.example/voice/webhook");
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(8_640_000_000_000_000);
    const session = handler.issueStreamSession({
      providerName: "telnyx",
      callId: "call-overflow",
      direction: "inbound",
    });
    nowSpy.mockRestore();
    const server = await startStreamSessionServer(handler, session.streamUrl);

    try {
      await expect(connectWs(server.url)).rejects.toThrow("Unexpected server response: 401");
      expect(createBridge).not.toHaveBeenCalled();
      expect(processEvent).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("rejects Telnyx stream starts that do not match the token-bound call", async () => {
    const processEvent = vi.fn();
    const getCall = vi.fn(
      (): CallRecord => ({
        callId: "call-1",
        providerCallId: "v3:call-1",
        provider: "telnyx",
        direction: "inbound",
        state: "answered",
        from: "+15550001234",
        to: "+15550009999",
        startedAt: Date.now(),
        transcript: [],
        processedEventIds: [],
        metadata: {},
      }),
    );
    const createBridge = vi.fn(() => makeBridge());
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCall,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    handler.setPublicUrl("https://public.example/voice/webhook");
    const session = handler.issueStreamSession({
      providerName: "telnyx",
      callId: "call-1",
      direction: "inbound",
    });
    const server = await startStreamSessionServer(handler, session.streamUrl);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          stream_id: "stream-1",
          start: { call_control_id: "v3:other" },
        }),
      );
      const close = await waitForClose(ws);

      expect(close.code).toBe(1008);
      expect(createBridge).not.toHaveBeenCalled();
      expect(processEvent).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("does not emit an outbound realtime greeting without an initial message", async () => {
    let callbacks:
      | {
          onReady?: () => void;
        }
      | undefined;
    const triggerGreeting = vi.fn();
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return makeBridge({ triggerGreeting });
      },
    );
    const getCallByProviderCallId = vi.fn(
      (): CallRecord => ({
        callId: "call-1",
        providerCallId: "CA-silent",
        provider: "twilio",
        direction: "outbound",
        state: "ringing",
        from: "+15550001234",
        to: "+15550009999",
        startedAt: Date.now(),
        transcript: [],
        processedEventIds: [],
        metadata: {},
      }),
    );
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-silent", callSid: "CA-silent" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        callbacks?.onReady?.();

        expect(triggerGreeting).not.toHaveBeenCalled();
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("speaks through the active outbound realtime bridge by call id", async () => {
    const triggerGreeting = vi.fn();
    const createBridge = vi.fn(() => makeBridge({ triggerGreeting }));
    const getCallByProviderCallId = vi.fn(
      (): CallRecord => ({
        callId: "call-1",
        providerCallId: "CA-speak",
        provider: "twilio",
        direction: "outbound",
        state: "ringing",
        from: "+15550001234",
        to: "+15550009999",
        startedAt: Date.now(),
        transcript: [],
        processedEventIds: [],
        metadata: {},
      }),
    );
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-speak", callSid: "CA-speak" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        expect(handler.speak("call-1", "Say exactly: hello from Meet.")).toEqual({
          success: true,
        });
        expect(triggerGreeting).toHaveBeenCalledWith("Say exactly: hello from Meet.");
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("cleans up realtime streams immediately and finalizes after disconnect grace", async () => {
    let callbacks:
      | {
          onClose?: (reason: "completed" | "error") => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    const processEvent = vi.fn();
    const close = vi.fn(() => {
      callbacks?.onTranscript?.("user", "last words", true);
      callbacks?.onClose?.("completed");
      throw new Error("provider close failed");
    });
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return makeBridge({ close });
      },
    );
    const getCallByProviderCallId = vi.fn(
      (): CallRecord => ({
        callId: "call-1",
        providerCallId: "CA-complete",
        provider: "twilio",
        direction: "inbound",
        state: "ringing",
        from: "+15550001234",
        to: "+15550009999",
        startedAt: Date.now(),
        transcript: [],
        processedEventIds: [],
        metadata: {},
      }),
    );
    const streamDisconnectLifecycle = createFinalizingStreamGrace(
      processEvent,
      "disconnect-grace-expired",
    );
    let resolveDisconnect: (() => void) | undefined;
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnect = resolve;
    });
    const originalDisconnect = streamDisconnectLifecycle.disconnect.bind(streamDisconnectLifecycle);
    const disconnect = vi
      .spyOn(streamDisconnectLifecycle, "disconnect")
      .mockImplementation((providerCallId, streamId) => {
        originalDisconnect(providerCallId, streamId);
        resolveDisconnect?.();
      });
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
      streamDisconnectLifecycle,
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-complete", callSid: "CA-complete" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        vi.useFakeTimers();
        ws.send(JSON.stringify({ event: "stop" }));

        await disconnected;
        const events = processEvent.mock.calls.map(([event]) => event as NormalizedEvent);
        expect(close).toHaveBeenCalledTimes(1);
        expect(disconnect).toHaveBeenCalledExactlyOnceWith("CA-complete", "MZ-complete");
        const speechIndex = events.findIndex((event) => event.type === "call.speech");
        expect(speechIndex).toBeGreaterThanOrEqual(0);
        expect(events.some((event) => event.type === "call.ended")).toBe(false);

        await vi.advanceTimersByTimeAsync(1_999);
        expect(processEvent.mock.calls.some(([event]) => event.type === "call.ended")).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        const endedEvents = processEvent.mock.calls
          .map(([event]) => event as NormalizedEvent)
          .filter((event) => event.type === "call.ended");
        expect(endedEvents).toEqual([
          expect.objectContaining({
            callId: "call-1",
            providerCallId: "CA-complete",
            reason: "completed",
          }),
        ]);

        vi.useRealTimers();
        const wsClosed = waitForClose(ws);
        ws.close();
        await wsClosed;
        expect(close).toHaveBeenCalledTimes(1);
        expect(
          processEvent.mock.calls.filter(([event]) => event.type === "call.ended"),
        ).toHaveLength(1);
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("delays finalization after an abnormal realtime WebSocket disconnect", async () => {
    const processEvent = vi.fn();
    const close = vi.fn();
    const createBridge = vi.fn(() => makeBridge({ close }));
    const providerCallId = "CA-abnormal-disconnect";
    const streamId = "MZ-abnormal-disconnect";
    const streamDisconnectLifecycle = createFinalizingStreamGrace(
      processEvent,
      "abnormal-disconnect-grace-expired",
    );
    let resolveDisconnect: (() => void) | undefined;
    const disconnected = new Promise<void>((resolve) => {
      resolveDisconnect = resolve;
    });
    const originalDisconnect = streamDisconnectLifecycle.disconnect.bind(streamDisconnectLifecycle);
    const disconnect = vi
      .spyOn(streamDisconnectLifecycle, "disconnect")
      .mockImplementation((disconnectedProviderCallId, disconnectedStreamId) => {
        originalDisconnect(disconnectedProviderCallId, disconnectedStreamId);
        resolveDisconnect?.();
      });
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCallByProviderCallId: vi.fn(() => makeCallRecord(providerCallId)),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
      streamDisconnectLifecycle,
    });
    const server = await startRealtimeServer(handler);
    const ws = await connectWs(server.url);

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: streamId, callSid: providerCallId },
        }),
      );
      await waitForRealtimeTest(() => expect(createBridge).toHaveBeenCalledTimes(1));

      vi.useFakeTimers();
      const closed = waitForClose(ws);
      ws.terminate();
      expect(await closed).toEqual({ code: 1006, reason: "" });
      await disconnected;

      expect(close).toHaveBeenCalledTimes(1);
      expect(disconnect).toHaveBeenCalledExactlyOnceWith(providerCallId, streamId);
      expect(processEvent.mock.calls.some(([event]) => event.type === "call.ended")).toBe(false);

      await vi.advanceTimersByTimeAsync(1_999);
      expect(processEvent.mock.calls.some(([event]) => event.type === "call.ended")).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        1,
      );
    } finally {
      vi.useRealTimers();
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });

  it("records common Talk events for realtime telephony sessions", async () => {
    let callbacks:
      | {
          onAudio?: (audio: Buffer) => void;
          onEvent?: (event: {
            direction: "client" | "server";
            type: string;
            detail?: string;
          }) => void;
          onReady?: () => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    const sendAudio = vi.fn();
    const processEvent = vi.fn();
    const call: CallRecord = {
      callId: "call-1",
      providerCallId: "CA-talk-events",
      provider: "twilio",
      direction: "inbound",
      state: "ringing",
      from: "+15550001234",
      to: "+15550009999",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {},
    };
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return makeBridge({ sendAudio });
      },
    );
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCallByProviderCallId: vi.fn((): CallRecord => call),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-talk-events", callSid: "CA-talk-events" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        callbacks?.onReady?.();
        ws.send(
          JSON.stringify({
            event: "media",
            media: { payload: Buffer.from([0xff, 0xff]).toString("base64") },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(sendAudio).toHaveBeenCalledWith(Buffer.from([0xff, 0xff]));
        });
        callbacks?.onTranscript?.("user", "hello", true);
        callbacks?.onAudio?.(Buffer.from([1, 2, 3]));
        callbacks?.onTranscript?.("assistant", "hi there", true);
        callbacks?.onEvent?.({ direction: "server", type: "response.done" });

        const recent = call.metadata?.recentTalkEvents as
          | Array<{
              brain: string;
              provider: string;
              sessionId: string;
              transport: string;
              type: string;
            }>
          | undefined;
        expect(recent?.map((event) => event.type)).toEqual([
          "session.started",
          "session.ready",
          "turn.started",
          "input.audio.delta",
          "transcript.done",
          "input.audio.committed",
          "output.audio.started",
          "output.audio.delta",
          "output.text.done",
          "output.audio.done",
          "turn.ended",
        ]);
        expect(recent?.[0]?.provider).toBe("openai");
        expect(recent?.[0]?.sessionId).toBe("voice-call:call-1:realtime");
        expect(recent?.[0]?.transport).toBe("gateway-relay");
        expect(call.metadata?.lastTalkEventType).toBe("turn.ended");
        expect(
          processEvent.mock.calls
            .map(([event]) => event as NormalizedEvent)
            .find((event) => event.type === "call.assistant-speech"),
        ).toMatchObject({
          type: "call.assistant-speech",
          transcript: "hi there",
        });
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("cancels the active turn when the provider confirms barge-in", async () => {
    await withBargeInHarness(
      { providerCallId: "CA-barge-in", handlesProviderBargeIn: true },
      async ({ callbacks, call }) => {
        callbacks?.onAudio?.(Buffer.from([1, 2, 3]));
        expect(recentTalkEvents(call).some((event) => event.type === "turn.cancelled")).toBe(false);
        callbacks?.onClearAudio("barge-in");

        await waitForRealtimeTest(() => {
          expect(requireCancelledTurn(call).turnId).toMatch(/^turn-\d+$/);
        });

        const cancelled = requireCancelledTurn(call);
        expect(
          recentTalkEvents(call).findLast((event) => event.type === "output.audio.done")?.turnId,
        ).toBe(cancelled.turnId);
      },
    );
  });

  it("starts fresh transcript and Talk state after provider continuity resets", async () => {
    await withBargeInHarness(
      { providerCallId: "CA-continuity-reset" },
      async ({ callbacks, call, outboundMessages, processEvent }) => {
        callbacks.onTranscript?.("user", "Old caller ", false);
        callbacks.onTranscript?.("assistant", "Old assistant ", false);
        callbacks.onAudio?.(Buffer.alloc(320, 0xff));
        const oldTurnId = recentTalkEvents(call).findLast(
          (event) => event.type === "turn.started",
        )?.turnId;
        expect(oldTurnId).toBeTruthy();

        callbacks.onEvent?.({
          direction: "client",
          type: "session.continuity.reset",
        });
        callbacks.onEvent?.({
          direction: "client",
          type: "session.continuity.reset",
        });

        await waitForRealtimeTest(() => {
          expect(outboundMessages.some((message) => message.event === "clear")).toBe(true);
        });
        expect(requireCancelledTurn(call).turnId).toBe(oldTurnId);
        const resetEvents = recentTalkEvents(call);
        expect(resetEvents.filter((event) => event.type === "turn.cancelled")).toHaveLength(1);
        expect(resetEvents.findIndex((event) => event.type === "output.audio.done")).toBeLessThan(
          resetEvents.findIndex((event) => event.type === "turn.cancelled"),
        );

        callbacks.onTranscript?.("user", "Fresh caller", true);
        callbacks.onTranscript?.("assistant", "Fresh assistant", true);
        callbacks.onEvent?.({ direction: "server", type: "response.done" });

        const processedEvents = processEvent.mock.calls.map(([event]) => event as NormalizedEvent);
        expect(
          processedEvents
            .filter((event) => event.type === "call.speech")
            .map((event) => (event.type === "call.speech" ? event.transcript : undefined)),
        ).toEqual(["Fresh caller"]);
        expect(
          processedEvents
            .filter((event) => event.type === "call.assistant-speech")
            .map((event) =>
              event.type === "call.assistant-speech" ? event.transcript : undefined,
            ),
        ).toEqual(["Fresh assistant"]);
        const startedTurns = recentTalkEvents(call).filter(
          (event) => event.type === "turn.started",
        );
        expect(startedTurns).toHaveLength(2);
        expect(startedTurns[1]?.turnId).not.toBe(oldTurnId);
      },
    );
  });

  it("passes the disabled input-interruption policy without cancelling speech-start", async () => {
    await withBargeInHarness(
      {
        providerCallId: "CA-disabled-barge-in",
        handlesProviderBargeIn: true,
        interruptResponseOnInputAudio: false,
      },
      async ({ callbacks, call, createBridge, outboundMessages }) => {
        expect(createBridge.mock.calls[0]?.[0].interruptResponseOnInputAudio).toBe(false);

        callbacks?.onAudio?.(Buffer.from([1, 2, 3]));
        await waitForRealtimeTest(() => {
          expect(outboundMessages.some((message) => message.event === "media")).toBe(true);
        });

        callbacks?.onEvent?.({ direction: "server", type: "input_audio_buffer.speech_started" });

        await Promise.resolve();
        expect(outboundMessages.some((message) => message.event === "clear")).toBe(false);
        expect(recentTalkEvents(call).some((event) => event.type === "turn.cancelled")).toBe(false);
      },
    );
  });

  it("clears queued telephony audio when provider barge-in follows response.done", async () => {
    await withBargeInHarness(
      { providerCallId: "CA-late-barge-in", handlesProviderBargeIn: true },
      async ({ callbacks, call, outboundMessages }) => {
        callbacks?.onAudio?.(Buffer.alloc(320, 0xff));
        await waitForRealtimeTest(() => {
          expect(outboundMessages.some((message) => message.event === "media")).toBe(true);
        });
        callbacks?.onEvent?.({ direction: "server", type: "response.done" });
        const clearCountBeforeBargeIn = outboundMessages.filter(
          (message) => message.event === "clear",
        ).length;

        callbacks?.onClearAudio("barge-in");

        await waitForRealtimeTest(() => {
          expect(outboundMessages.filter((message) => message.event === "clear").length).toBe(
            clearCountBeforeBargeIn + 1,
          );
        });
        expect(
          recentTalkEvents(call).filter((event) => event.type === "turn.cancelled"),
        ).toHaveLength(0);
      },
    );
  });

  it("keeps local barge-in fallback for providers without speech-started events", async () => {
    await withBargeInHarness(
      { providerCallId: "CA-local-barge-in" },
      async ({ callbacks, call, handleBargeIn, outboundMessages, sendAudio, ws }) => {
        callbacks?.onAudio?.(Buffer.from([1, 2, 3]));
        for (let i = 0; i < 4; i += 1) {
          ws.send(
            JSON.stringify({
              event: "media",
              media: { payload: Buffer.alloc(160, 0x00).toString("base64") },
            }),
          );
        }

        await waitForRealtimeTest(() => {
          expect(sendAudio).toHaveBeenCalledTimes(4);
          expect(requireCancelledTurn(call).turnId).toMatch(/^turn-\d+$/);
          expect(outboundMessages.some((message) => message.event === "clear")).toBe(true);
        });

        const cancelled = requireCancelledTurn(call);
        expect(handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
        expect(
          recentTalkEvents(call).findLast((event) => event.type === "output.audio.done")?.turnId,
        ).toBe(cancelled.turnId);
      },
    );
  });

  it("lets a session bridge override provider-level barge-in capabilities", async () => {
    await withBargeInHarness(
      {
        bridgeHandlesInputAudioBargeIn: false,
        handlesProviderBargeIn: true,
        providerCallId: "CA-bridge-local-barge-in",
      },
      async ({ callbacks, call, handleBargeIn, outboundMessages, sendAudio, ws }) => {
        callbacks?.onAudio?.(Buffer.from([1, 2, 3]));
        for (let i = 0; i < 4; i += 1) {
          ws.send(
            JSON.stringify({
              event: "media",
              media: { payload: Buffer.alloc(160, 0x00).toString("base64") },
            }),
          );
        }

        await waitForRealtimeTest(() => {
          expect(sendAudio).toHaveBeenCalledTimes(4);
          expect(requireCancelledTurn(call).turnId).toMatch(/^turn-\d+$/);
          expect(outboundMessages.some((message) => message.event === "clear")).toBe(true);
        });
        expect(handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
      },
    );
  });

  it("clears remote playback after local pacing and output state have finished", async () => {
    await withBargeInHarness(
      { providerCallId: "CA-late-local-barge-in" },
      async ({ callbacks, call, handleBargeIn, outboundMessages, ws }) => {
        callbacks?.onAudio?.(Buffer.from([1, 2, 3]));
        await waitForRealtimeTest(() => {
          expect(outboundMessages.some((message) => message.event === "media")).toBe(true);
        });
        callbacks?.onEvent?.({ direction: "server", type: "response.done" });
        const clearCountBeforeBargeIn = outboundMessages.filter(
          (message) => message.event === "clear",
        ).length;

        for (let i = 0; i < 4; i += 1) {
          ws.send(
            JSON.stringify({
              event: "media",
              media: { payload: Buffer.alloc(160, 0x00).toString("base64") },
            }),
          );
        }

        await waitForRealtimeTest(() => {
          expect(handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: false });
          expect(outboundMessages.filter((message) => message.event === "clear").length).toBe(
            clearCountBeforeBargeIn + 1,
          );
        });
        expect(
          recentTalkEvents(call).filter((event) => event.type === "turn.cancelled"),
        ).toHaveLength(0);
      },
    );
  });

  it("ends the closure-bound current call without requesting another provider response", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const closeBridge = vi.fn();
    const submitToolResult = vi.fn();
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge({ close: closeBridge, submitToolResult });
    });
    const call = makeCallRecord("CA-end-current");
    const endCall = vi.fn(async (_callId: string) => ({ success: true }));
    const handler = makeHandler(undefined, {
      manager: {
        endCall,
        getCallByProviderCallId: vi.fn(() => call),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);
    const ws = await connectWs(server.url);

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-end-current", callSid: "CA-end-current" },
        }),
      );
      await waitForRealtimeTest(() => expect(createBridge).toHaveBeenCalledOnce());

      const closed = waitForClose(ws);
      callbacks?.onToolCall?.({
        itemId: "item-end-current",
        callId: "provider-end-current",
        name: "openclaw_end_call",
        args: {},
      });

      await waitForRealtimeTest(() => {
        expect(endCall).toHaveBeenCalledExactlyOnceWith("call-1");
        expect(closeBridge).toHaveBeenCalledOnce();
      });
      expect(await closed).toEqual({ code: 1000, reason: "Call ended" });
      expect(submitToolResult).not.toHaveBeenCalled();
      expect(recentTalkEvents(call)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tool.result" })]),
      );
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });

  it("reports an actionable end-call failure while leaving the current call connected", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const closeBridge = vi.fn();
    const submitToolResult = vi.fn();
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge({ close: closeBridge, submitToolResult });
    });
    const call = makeCallRecord("CA-end-failed");
    const endCall = vi.fn(async () => ({ success: false, error: "carrier rejected hangup" }));
    const handler = makeHandler(undefined, {
      manager: {
        endCall,
        getCallByProviderCallId: vi.fn(() => call),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);
    const ws = await connectWs(server.url);

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-end-failed", callSid: "CA-end-failed" },
        }),
      );
      await waitForRealtimeTest(() => expect(createBridge).toHaveBeenCalledOnce());

      callbacks?.onToolCall?.({
        itemId: "item-end-failed",
        callId: "provider-end-failed",
        name: "openclaw_end_call",
        args: {},
      });

      await waitForRealtimeTest(() => {
        expect(submitToolResult).toHaveBeenCalledWith(
          "provider-end-failed",
          {
            error:
              "Could not end the current phone call: carrier rejected hangup. Tell the caller the call could not be ended and they can hang up or ask you to try again.",
          },
          undefined,
        );
      });
      expect(endCall).toHaveBeenCalledExactlyOnceWith("call-1");
      expect(closeBridge).not.toHaveBeenCalled();
      expect(ws.readyState).toBe(WebSocket.OPEN);
      expect(recentTalkEvents(call)).toEqual(
        expect.arrayContaining([expect.objectContaining({ type: "tool.error" })]),
      );
    } finally {
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close();
      }
      await handler.close();
      await server.close();
    }
  });

  it("ignores an end-call callback from a retired predecessor bridge", async () => {
    const callbacks: RealtimeBridgeRequest[] = [];
    const predecessorClose = vi.fn();
    const replacementClose = vi.fn();
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks.push(request);
      return makeBridge({ close: callbacks.length === 1 ? predecessorClose : replacementClose });
    });
    const call = makeCallRecord("CA-end-replacement");
    const endCall = vi.fn(async (_callId: string) => ({ success: true }));
    const handler = makeHandler(undefined, {
      manager: {
        endCall,
        getCallByProviderCallId: vi.fn(() => call),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const predecessorServer = await startRealtimeServer(handler);
    const predecessorWs = await connectWs(predecessorServer.url);
    let replacementServer: Awaited<ReturnType<typeof startRealtimeServer>> | undefined;
    let replacementWs: WebSocket | undefined;

    try {
      predecessorWs.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-end-predecessor", callSid: "CA-end-replacement" },
        }),
      );
      await waitForRealtimeTest(() => expect(createBridge).toHaveBeenCalledTimes(1));

      replacementServer = await startRealtimeServer(handler);
      replacementWs = await connectWs(replacementServer.url);
      replacementWs.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-end-replacement", callSid: "CA-end-replacement" },
        }),
      );
      await waitForRealtimeTest(() => expect(createBridge).toHaveBeenCalledTimes(2));
      expect(predecessorClose).toHaveBeenCalledOnce();

      callbacks[0]?.onToolCall?.({
        itemId: "item-end-stale",
        callId: "provider-end-stale",
        name: "openclaw_end_call",
        args: {},
      });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      expect(endCall).not.toHaveBeenCalled();
      expect(replacementClose).not.toHaveBeenCalled();
      expect(replacementWs.readyState).toBe(WebSocket.OPEN);
    } finally {
      if (
        replacementWs &&
        replacementWs.readyState !== WebSocket.CLOSED &&
        replacementWs.readyState !== WebSocket.CLOSING
      ) {
        replacementWs.close();
      }
      if (
        predecessorWs.readyState !== WebSocket.CLOSED &&
        predecessorWs.readyState !== WebSocket.CLOSING
      ) {
        predecessorWs.close();
      }
      await handler.close();
      await replacementServer?.close();
      await predecessorServer.close();
    }
  });

  it("submits continuing responses only for realtime agent consult calls", async () => {
    let callbacks:
      | {
          onToolCall?: (event: {
            itemId: string;
            callId: string;
            name: string;
            args: unknown;
          }) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    let resolveConsult: ((value: unknown) => void) | undefined;
    let resolveWorkingSubmission: (() => void) | undefined;
    let rejectWorkingSubmission = false;
    const resolveFinalSubmissions: Array<() => void> = [];
    let receivedPartialTranscript: string | undefined;
    const submitToolResult = vi.fn(
      (_callId: string, result: unknown, _options?: unknown): void | Promise<void> => {
        if (
          rejectWorkingSubmission &&
          result &&
          typeof result === "object" &&
          "status" in result &&
          result.status === "working"
        ) {
          return Promise.reject(new Error("working result rejected"));
        }
        if (
          _callId === "consult-call" &&
          result &&
          typeof result === "object" &&
          "status" in result &&
          result.status === "working"
        ) {
          return new Promise<void>((resolve) => {
            resolveWorkingSubmission = resolve;
          });
        }
        if (
          result &&
          typeof result === "object" &&
          "text" in result &&
          result.text === "The basement lights are on."
        ) {
          return new Promise<void>((resolve) => {
            resolveFinalSubmissions.push(resolve);
          });
        }
        return undefined;
      },
    );
    const bridge = makeBridge({
      supportsToolResultContinuation: true,
      submitToolResult,
    });
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return bridge;
      },
    );
    const call: CallRecord = {
      callId: "call-1",
      providerCallId: "CA-tool",
      provider: "twilio",
      direction: "inbound",
      state: "ringing",
      from: "+15550001234",
      to: "+15550009999",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {},
    };
    const getCallByProviderCallId = vi.fn((): CallRecord => call);
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const consultHandler = vi.fn(
      (_args: unknown, _callId: string, context: { partialUserTranscript?: string }) => {
        receivedPartialTranscript = context.partialUserTranscript;
        return new Promise((resolve) => {
          resolveConsult = resolve;
        });
      },
    );
    handler.registerToolHandler("openclaw_agent_consult", consultHandler);
    handler.registerToolHandler("custom_lookup", async () => ({ ok: true }));
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-tool", callSid: "CA-tool" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        vi.useFakeTimers();
        callbacks?.onTranscript?.("user", "Are the basement", false);
        callbacks?.onToolCall?.({
          itemId: "item-1",
          callId: "consult-call",
          name: "openclaw_agent_consult",
          args: { question: "Are the basement lights on?" },
        });
        callbacks?.onToolCall?.({
          itemId: "item-2",
          callId: "consult-call-2",
          name: "openclaw_agent_consult",
          args: { question: "Are the basement lights on?" },
        });
        expect(receivedPartialTranscript).toBeUndefined();
        resolveWorkingSubmission?.();
        await vi.advanceTimersByTimeAsync(350);
        await waitForRealtimeTest(() => {
          expect(receivedPartialTranscript).toBe("Are the basement");
        });

        await waitForRealtimeTest(() => {
          const workingCall = submitToolResult.mock.calls.find(
            ([callId]) => callId === "consult-call",
          );
          if (!workingCall) {
            throw new Error("expected consult-call tool result");
          }
          const payload = workingCall[1] as Record<string, unknown> | undefined;
          expect(payload?.status).toBe("working");
          expect(payload?.tool).toBe("openclaw_agent_consult");
          expect(typeof payload?.message).toBe("string");
          expect(workingCall[2]).toEqual({ willContinue: true });
        });
        expect(
          submitToolResult.mock.calls.filter(
            ([, result]) =>
              result &&
              typeof result === "object" &&
              "status" in result &&
              result.status === "working",
          ),
        ).toHaveLength(2);

        resolveConsult?.({ text: "The basement lights are on." });

        await waitForRealtimeTest(() => {
          expect(submitToolResult).toHaveBeenLastCalledWith(
            "consult-call-2",
            {
              text: "The basement lights are on.",
            },
            undefined,
          );
        });
        expect(recentTalkEvents(call).some((event) => event.type === "tool.result")).toBe(false);
        for (const resolve of resolveFinalSubmissions) {
          resolve();
        }
        await waitForRealtimeTest(() => {
          expect(recentTalkEvents(call).some((event) => event.type === "tool.result")).toBe(true);
        });
        expect(consultHandler).toHaveBeenCalledTimes(1);

        submitToolResult.mockClear();
        callbacks?.onToolCall?.({
          itemId: "item-2",
          callId: "custom-call",
          name: "custom_lookup",
          args: {},
        });

        await waitForRealtimeTest(() => {
          expect(submitToolResult).toHaveBeenCalledWith("custom-call", { ok: true }, undefined);
        });
        const customCallResults = submitToolResult.mock.calls.filter(
          ([callId]) => callId === "custom-call",
        );
        expect(customCallResults).toHaveLength(1);
        expect(customCallResults[0]?.[2]).toBeUndefined();

        submitToolResult.mockClear();
        rejectWorkingSubmission = true;
        callbacks?.onToolCall?.({
          itemId: "item-rejected",
          callId: "consult-rejected",
          name: "openclaw_agent_consult",
          args: { question: "Do not run this twice" },
        });
        await waitForRealtimeTest(() => {
          expect(submitToolResult).toHaveBeenCalledTimes(1);
        });
        await vi.advanceTimersByTimeAsync(0);
        expect(consultHandler).toHaveBeenCalledTimes(1);
        expect(submitToolResult).toHaveBeenCalledWith(
          "consult-rejected",
          expect.objectContaining({ status: "working" }),
          { willContinue: true },
        );
      } finally {
        vi.useRealTimers();
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("terminally satisfies a late native call for a cancelled forced consult", async () => {
    let callbacks:
      | {
          onToolCall?: (event: {
            itemId: string;
            callId: string;
            name: string;
            args: unknown;
          }) => void;
        }
      | undefined;
    let sessionHarness: RealtimeVoiceSessionHarness | undefined;
    realtimeVoiceHarnessTestHooks.onCreate = (harness) => {
      sessionHarness = harness;
    };
    const submitToolResult = vi.fn();
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return makeBridge({ submitToolResult });
      },
    );
    const call: CallRecord = {
      callId: "call-1",
      providerCallId: "CA-cancelled-consult",
      provider: "twilio",
      direction: "inbound",
      state: "ringing",
      from: "+15550001234",
      to: "+15550009999",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
      metadata: {},
    };
    const handler = makeHandler(undefined, {
      manager: { getCallByProviderCallId: vi.fn(() => call) },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const consult = vi.fn(async () => ({ text: "should not run" }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-cancelled-consult", callSid: call.providerCallId },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
          expect(sessionHarness).toBeDefined();
        });

        const coordinator = expectDefined(
          sessionHarness,
          "voice-call realtime session harness",
        ).forcedConsults;
        const cancelled = coordinator.prepare("cancelled question");
        if (!cancelled) {
          throw new Error("expected forced consult handle");
        }
        coordinator.markStarted(cancelled);
        coordinator.markCancelled(cancelled);

        callbacks?.onToolCall?.({
          itemId: "item-cancelled",
          callId: "native-cancelled",
          name: "openclaw_agent_consult",
          args: { question: "cancelled question" },
        });

        await waitForRealtimeTest(() => {
          expect(submitToolResult).toHaveBeenCalledWith(
            "native-cancelled",
            {
              status: "cancelled",
              message: "OpenClaw cancelled this consult before completion. Do not restart it.",
            },
            undefined,
          );
        });
        expect(consult).not.toHaveBeenCalled();
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("forces an agent consult from final user transcript when consult policy is always", async () => {
    let callbacks:
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    const sendUserMessage = vi.fn();
    const bridge = makeBridge({ sendUserMessage });
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return bridge;
      },
    );
    const handler = makeHandler(
      { consultPolicy: "always" },
      {
        manager: {
          getCallByProviderCallId: vi.fn(
            (): CallRecord => ({
              callId: "call-1",
              providerCallId: "CA-force",
              provider: "twilio",
              direction: "inbound",
              state: "ringing",
              from: "+15550001234",
              to: "+15550009999",
              startedAt: Date.now(),
              transcript: [],
              processedEventIds: [],
              metadata: {},
            }),
          ),
        },
        realtimeProvider: makeRealtimeProvider(createBridge),
      },
    );
    const consult = vi.fn<
      (args: unknown, callId: string, context: Record<string, unknown>) => Promise<{ text: string }>
    >(async () => ({ text: "I created the smoke test file." }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-force", callSid: "CA-force" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        vi.useFakeTimers();
        callbacks?.onTranscript?.("user", "Create a smoke test file for me.", true);
        await vi.advanceTimersByTimeAsync(200);

        await waitForRealtimeTest(() => {
          expect(consult).toHaveBeenCalledTimes(1);
        });
        const [args, callId, context] = requireFirstMockCall(consult.mock.calls, "consult");
        expect(args).toEqual({
          question: "Create a smoke test file for me.",
        });
        expect(JSON.stringify(args)).not.toContain("consultPolicy");
        expect(JSON.stringify(args)).not.toContain("openclaw_agent_consult");
        expect(callId).toBe("call-1");
        expect(context).toEqual({ abortSignal: expect.any(AbortSignal) });
        await waitForRealtimeTest(() => {
          expect(sendUserMessage).toHaveBeenCalledTimes(1);
          expect(requireFirstMockCall(sendUserMessage.mock.calls, "user message")).toEqual([
            "Internal OpenClaw consult result is ready.\nDo not call tools for this internal result.\nSpeak the following answer to the caller now, briefly and naturally:\nI created the smoke test file.",
          ]);
        });
      } finally {
        vi.useRealTimers();
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("clears cancelled consult dedupe for a fresh provider session", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    let sessionHarness: RealtimeVoiceSessionHarness | undefined;
    realtimeVoiceHarnessTestHooks.onCreate = (harness) => {
      sessionHarness = harness;
    };
    const submitToolResult = vi.fn();
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      return makeBridge({ submitToolResult });
    });
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId: vi.fn((providerCallId: string) => makeCallRecord(providerCallId)),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const consult = vi.fn(async () => ({ text: "fresh consult answer" }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-continuity-consult", callSid: "CA-continuity-consult" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(callbacks).toBeDefined();
          expect(sessionHarness).toBeDefined();
        });

        const coordinator = expectDefined(
          sessionHarness,
          "voice-call realtime session harness",
        ).forcedConsults;
        const cancelled = expectDefined(
          coordinator.prepare("same question"),
          "cancelled forced consult",
        );
        coordinator.markStarted(cancelled);
        coordinator.markCancelled(cancelled);

        callbacks?.onEvent?.({
          direction: "client",
          type: "session.continuity.reset",
        });
        callbacks?.onEvent?.({
          direction: "client",
          type: "session.continuity.reset",
        });
        expect(coordinator.handles()).toEqual([]);

        callbacks?.onToolCall?.({
          itemId: "item-fresh",
          callId: "native-fresh",
          name: "openclaw_agent_consult",
          args: { question: "same question" },
        });

        await waitForRealtimeTest(() => {
          expect(consult).toHaveBeenCalledTimes(1);
          expect(submitToolResult).toHaveBeenCalledWith(
            "native-fresh",
            { text: "fresh consult answer" },
            undefined,
          );
        });
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("aborts a forced consult when its realtime session closes", async () => {
    let callbacks:
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    const sendUserMessage = vi.fn();
    const closeBridge = vi.fn();
    const bridge = makeBridge({ close: closeBridge, sendUserMessage });
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return bridge;
      },
    );
    const handler = makeHandler(
      { consultPolicy: "always" },
      {
        manager: {
          getCallByProviderCallId: vi.fn(() => makeCallRecord("CA-forced-close")),
        },
        realtimeProvider: makeRealtimeProvider(createBridge),
      },
    );
    let consultSignal: AbortSignal | undefined;
    const consult = vi.fn(
      async (_args: unknown, _callId: string, context: { abortSignal?: AbortSignal }) => {
        consultSignal = context.abortSignal;
        return await new Promise<{ text: string }>((_resolve, reject) => {
          context.abortSignal?.addEventListener(
            "abort",
            () =>
              reject(new Error("forced consult aborted", { cause: context.abortSignal?.reason })),
            { once: true },
          );
        });
      },
    );
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const clearAudio = vi.spyOn(RealtimeAudioPacer.prototype, "clearAudio");
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-forced-close", callSid: "CA-forced-close" },
        }),
      );
      await waitForRealtimeTest(() => {
        expect(createBridge).toHaveBeenCalledTimes(1);
      });

      callbacks?.onTranscript?.("user", "Check the deployment.", true);
      await waitForRealtimeTest(() => {
        expect(consult).toHaveBeenCalledTimes(1);
      });
      expect(clearAudio).toHaveBeenCalledTimes(1);

      const closed = waitForClose(ws);
      ws.close();
      await closed;
      await waitForRealtimeTest(() => {
        expect(closeBridge).toHaveBeenCalledTimes(1);
      });

      expect(consultSignal?.aborted).toBe(true);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
      });

      expect(clearAudio).toHaveBeenCalledTimes(1);
      expect(sendUserMessage).not.toHaveBeenCalled();
    } finally {
      clearAudio.mockRestore();
      await server.close();
    }
  });

  it("keeps a replacement session's forced consult when the old result resolves late", async () => {
    const sessionHarnesses: RealtimeVoiceSessionHarness[] = [];
    realtimeVoiceHarnessTestHooks.onCreate = (harness) => {
      sessionHarnesses.push(harness);
    };
    const callbacks: RealtimeBridgeRequest[] = [];
    const oldSendUserMessage = vi.fn();
    const replacementSendUserMessage = vi.fn();
    const oldSubmitToolResult = vi.fn();
    const oldCloseBridge = vi.fn();
    const replacementCloseBridge = vi.fn();
    const bridges = [
      makeBridge({
        close: oldCloseBridge,
        sendUserMessage: oldSendUserMessage,
        submitToolResult: oldSubmitToolResult,
      }),
      makeBridge({
        close: replacementCloseBridge,
        sendUserMessage: replacementSendUserMessage,
      }),
    ];
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks.push(request);
        const bridge = bridges[callbacks.length - 1];
        if (!bridge) {
          throw new Error("unexpected replacement bridge");
        }
        return bridge;
      },
    );
    const handler = makeHandler(
      { consultPolicy: "always" },
      {
        manager: {
          getCallByProviderCallId: vi.fn((providerCallId: string) =>
            makeCallRecord(providerCallId),
          ),
        },
        realtimeProvider: makeRealtimeProvider(createBridge),
      },
    );
    const oldResult = createDeferred<{ text: string }>();
    const replacementResult = createDeferred<{ text: string }>();
    const consult = vi
      .fn()
      .mockImplementationOnce(() => oldResult.promise)
      .mockImplementationOnce(() => replacementResult.promise);
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const clearAudio = vi.spyOn(RealtimeAudioPacer.prototype, "clearAudio");
    const oldServer = await startRealtimeServer(handler);
    let replacementServer: Awaited<ReturnType<typeof startRealtimeServer>> | undefined;
    let oldWs: WebSocket | undefined;

    try {
      oldWs = await connectWs(oldServer.url);
      oldWs.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-forced-old", callSid: "CA-forced-old" },
        }),
      );
      await waitForRealtimeTest(() => {
        expect(callbacks).toHaveLength(1);
      });
      callbacks[0]?.onTranscript?.("user", "Check the old deployment.", true);
      await waitForRealtimeTest(() => {
        expect(consult).toHaveBeenCalledTimes(1);
      });
      const oldCoordinator = expectDefined(
        sessionHarnesses[0],
        "old voice-call realtime session harness",
      ).forcedConsults;
      const oldForcedHandle = expectDefined(
        oldCoordinator.handles().find((handle) => handle.question === "Check the old deployment."),
        "old forced consult handle",
      );
      const stalePendingHandle = expectDefined(
        oldCoordinator.prepare("Pending work from the old session."),
        "stale pending forced consult handle",
      );
      const stalePendingRun = vi.fn();
      oldCoordinator.schedule(stalePendingHandle, 60_000, stalePendingRun);
      callbacks[0]?.onToolCall?.({
        itemId: "item-old-native",
        callId: "old-native-consult",
        name: "openclaw_agent_consult",
        args: { question: "Check the old deployment." },
      });
      expect(consult).toHaveBeenCalledTimes(1);

      replacementServer = await startRealtimeServer(handler);
      const replacementWs = await connectWs(replacementServer.url);
      try {
        replacementWs.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-forced-replacement", callSid: "CA-forced-replacement" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(callbacks).toHaveLength(2);
        });
        expect(oldCoordinator.handles()).not.toContainEqual(stalePendingHandle);
        expect(stalePendingRun).not.toHaveBeenCalled();
        callbacks[1]?.onTranscript?.("user", "Check the new deployment.", true);
        await waitForRealtimeTest(() => {
          expect(consult).toHaveBeenCalledTimes(2);
        });
        expect(clearAudio).toHaveBeenCalledTimes(2);

        callbacks[0]?.onToolCall?.({
          itemId: "item-stale-native",
          callId: "stale-native-consult",
          name: "openclaw_agent_consult",
          args: { question: "Check the old deployment." },
        });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        expect(oldSubmitToolResult).not.toHaveBeenCalled();
        expect(consult).toHaveBeenCalledTimes(2);

        oldResult.resolve({ text: "The old deployment is healthy." });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        expect(clearAudio).toHaveBeenCalledTimes(2);
        expect(oldSendUserMessage).not.toHaveBeenCalled();
        expect(oldCoordinator.handles()).not.toContainEqual(oldForcedHandle);

        const oldClosed = waitForClose(oldWs);
        oldWs.close();
        await oldClosed;
        await waitForRealtimeTest(() => {
          expect(oldCloseBridge).toHaveBeenCalledTimes(1);
        });

        replacementResult.resolve({ text: "The new deployment is healthy." });
        await waitForRealtimeTest(() => {
          expect(replacementSendUserMessage).toHaveBeenCalledTimes(1);
        });
        expect(clearAudio).toHaveBeenCalledTimes(3);
      } finally {
        if (
          replacementWs.readyState !== WebSocket.CLOSED &&
          replacementWs.readyState !== WebSocket.CLOSING
        ) {
          replacementWs.close();
        }
      }
    } finally {
      if (
        oldWs &&
        oldWs.readyState !== WebSocket.CLOSED &&
        oldWs.readyState !== WebSocket.CLOSING
      ) {
        oldWs.close();
      }
      clearAudio.mockRestore();
      await replacementServer?.close();
      await oldServer.close();
    }
  });

  it("retires predecessor audio and isolates late bridge events from its replacement", async () => {
    const callbacks: RealtimeBridgeRequest[] = [];
    const oldCloseBridge = vi.fn();
    const replacementCloseBridge = vi.fn();
    const bridges = [
      makeBridge({ close: oldCloseBridge }),
      makeBridge({ close: replacementCloseBridge }),
    ];
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks.push(request);
      const bridge = bridges[callbacks.length - 1];
      if (!bridge) {
        throw new Error("unexpected replacement bridge");
      }
      if (callbacks.length === 2) {
        request.onTranscript?.("user", "Fresh ", false);
      }
      return bridge;
    });
    const processEvent = vi.fn();
    const endCall = vi.fn(async () => ({ success: true }));
    const sharedCallSid = "CA-continuity-shared";
    const call = makeCallRecord(sharedCallSid);
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId: vi.fn(() => call),
        processEvent,
        endCall,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const oldServer = await startRealtimeServer(handler);
    let replacementServer: Awaited<ReturnType<typeof startRealtimeServer>> | undefined;
    let oldWs: WebSocket | undefined;

    try {
      oldWs = await connectWs(oldServer.url);
      oldWs.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-continuity-old", callSid: sharedCallSid },
        }),
      );
      await waitForRealtimeTest(() => {
        expect(callbacks).toHaveLength(1);
      });
      callbacks[0]?.onTranscript?.("user", "Old ", false);

      replacementServer = await startRealtimeServer(handler);
      const replacementWs = await connectWs(replacementServer.url);
      const replacementOutboundMessages: Array<Record<string, unknown>> = [];
      replacementWs.on("message", (data) => {
        replacementOutboundMessages.push(parseWebSocketMessage(data));
      });
      try {
        replacementWs.send(
          JSON.stringify({
            event: "start",
            start: {
              streamSid: "MZ-continuity-replacement",
              callSid: sharedCallSid,
            },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(callbacks).toHaveLength(2);
          expect(oldCloseBridge).toHaveBeenCalledOnce();
        });

        callbacks[0]?.onAudio(Buffer.from([0x01]));
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
        expect(replacementOutboundMessages).toHaveLength(0);

        callbacks[1]?.onAudio(Buffer.from([0x02]));
        await waitForRealtimeTest(() => {
          expect(replacementOutboundMessages).toEqual([
            expect.objectContaining({
              event: "media",
              media: { payload: Buffer.from([0x02]).toString("base64") },
            }),
          ]);
        });

        callbacks[0]?.onTranscript?.("user", "stale partial", false);
        callbacks[0]?.onTranscript?.("user", "stale final", true);
        callbacks[0]?.onTranscript?.("assistant", "stale assistant", true);
        callbacks[0]?.onEvent?.({
          direction: "client",
          type: "session.continuity.reset",
        });
        callbacks[0]?.onEvent?.({
          direction: "client",
          type: "session.continuity.reset",
        });
        const oldClosed = waitForClose(oldWs);
        callbacks[0]?.onClose?.("error");
        await oldClosed;
        await waitForRealtimeTest(() => {
          expect(oldCloseBridge).toHaveBeenCalledOnce();
        });
        expect(replacementCloseBridge).not.toHaveBeenCalled();
        expect(endCall).not.toHaveBeenCalled();
        expect(
          processEvent.mock.calls
            .map(([event]) => event as NormalizedEvent)
            .filter((event) => event.type === "call.ended"),
        ).toHaveLength(0);
        callbacks[1]?.onTranscript?.("user", "caller", true);

        await waitForRealtimeTest(() => {
          expect(
            processEvent.mock.calls
              .map(([event]) => event as NormalizedEvent)
              .filter((event) => event.type === "call.speech")
              .map((event) => (event.type === "call.speech" ? event.transcript : undefined)),
          ).toEqual(["Fresh caller"]);
        });
        expect(
          processEvent.mock.calls
            .map(([event]) => event as NormalizedEvent)
            .filter((event) => event.type === "call.assistant-speech"),
        ).toHaveLength(0);
      } finally {
        if (
          replacementWs.readyState !== WebSocket.CLOSED &&
          replacementWs.readyState !== WebSocket.CLOSING
        ) {
          replacementWs.close();
        }
      }
    } finally {
      if (
        oldWs &&
        oldWs.readyState !== WebSocket.CLOSED &&
        oldWs.readyState !== WebSocket.CLOSING
      ) {
        oldWs.close();
      }
      await replacementServer?.close();
      await oldServer.close();
    }
  });

  it("preserves the predecessor when replacement closes with error during creation", async () => {
    const callbacks: RealtimeBridgeRequest[] = [];
    const oldTriggerGreeting = vi.fn();
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks.push(request);
      if (callbacks.length === 1) {
        return makeBridge({ triggerGreeting: oldTriggerGreeting });
      }
      request.onTranscript?.("user", "Failed ", false);
      request.onClose?.("error");
      throw new Error("replacement bridge failed");
    });
    const processEvent = vi.fn();
    const endCall = vi.fn(async () => ({ success: true }));
    const sharedCallSid = "CA-transcript-rollback";
    const call = makeCallRecord(sharedCallSid);
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId: vi.fn(() => call),
        processEvent,
        endCall,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const oldServer = await startRealtimeServer(handler);
    let replacementServer: Awaited<ReturnType<typeof startRealtimeServer>> | undefined;
    let oldWs: WebSocket | undefined;

    try {
      oldWs = await connectWs(oldServer.url);
      oldWs.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-transcript-rollback-old", callSid: sharedCallSid },
        }),
      );
      await waitForRealtimeTest(() => {
        expect(callbacks).toHaveLength(1);
      });
      callbacks[0]?.onTranscript?.("user", "Old ", false);

      replacementServer = await startRealtimeServer(handler);
      const replacementWs = await connectWs(replacementServer.url);
      try {
        replacementWs.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-transcript-rollback-new", callSid: sharedCallSid },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalledTimes(2);
        });

        expect(handler.speak(call.callId, "Continue the existing call.")).toEqual({
          success: true,
        });
        expect(oldTriggerGreeting).toHaveBeenCalledWith("Continue the existing call.");
        expect(endCall).not.toHaveBeenCalled();
        expect(
          processEvent.mock.calls
            .map(([event]) => event as NormalizedEvent)
            .filter((event) => event.type === "call.ended"),
        ).toHaveLength(0);

        callbacks[0]?.onTranscript?.("user", "caller", true);
        await waitForRealtimeTest(() => {
          expect(
            processEvent.mock.calls
              .map(([event]) => event as NormalizedEvent)
              .filter((event) => event.type === "call.speech")
              .map((event) => (event.type === "call.speech" ? event.transcript : undefined)),
          ).toEqual(["Old caller"]);
        });
      } finally {
        if (
          replacementWs.readyState !== WebSocket.CLOSED &&
          replacementWs.readyState !== WebSocket.CLOSING
        ) {
          replacementWs.close();
        }
      }
    } finally {
      if (
        oldWs &&
        oldWs.readyState !== WebSocket.CLOSED &&
        oldWs.readyState !== WebSocket.CLOSING
      ) {
        oldWs.close();
      }
      await replacementServer?.close();
      await oldServer.close();
    }
  });

  it("cleans provisional transcript state when initial bridge creation fails", async () => {
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      request.onTranscript?.("user", "orphaned", false);
      throw new Error("initial bridge failed");
    });
    const call = makeCallRecord("CA-transcript-initial-failure");
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId: vi.fn(() => call),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);
    const ws = await connectWs(server.url);

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: {
            streamSid: "MZ-transcript-initial-failure",
            callSid: "CA-transcript-initial-failure",
          },
        }),
      );
      await waitForRealtimeTest(() => {
        expect(createBridge).toHaveBeenCalledOnce();
      });
      expect(
        (
          handler as unknown as {
            userTranscriptStatesByCallId: Map<string, unknown>;
          }
        ).userTranscriptStatesByCallId.size,
      ).toBe(0);
    } finally {
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close();
      }
      await server.close();
    }
  });

  it("keeps provisional transcript ownership across synchronous provider close", async () => {
    let callbacks: RealtimeBridgeRequest | undefined;
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks = request;
      request.onClose?.("completed");
      return makeBridge();
    });
    const processEvent = vi.fn();
    const call = makeCallRecord("CA-transcript-synchronous-close");
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId: vi.fn(() => call),
        processEvent,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);
    const ws = await connectWs(server.url);

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: {
            streamSid: "MZ-transcript-synchronous-close",
            callSid: "CA-transcript-synchronous-close",
          },
        }),
      );
      await waitForRealtimeTest(() => {
        expect(createBridge).toHaveBeenCalledOnce();
      });
      callbacks?.onTranscript?.("user", "Still listening", true);
      await waitForRealtimeTest(() => {
        expect(processEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            transcript: "Still listening",
            type: "call.speech",
          }),
        );
      });
    } finally {
      if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
        ws.close();
      }
      await server.close();
    }
  });

  it("does not share a native consult with a replacement realtime session", async () => {
    const callbacks: RealtimeBridgeRequest[] = [];
    const oldSubmitToolResult = vi.fn();
    const replacementSubmitToolResult = vi.fn();
    const bridges = [
      makeBridge({
        supportsToolResultContinuation: true,
        submitToolResult: oldSubmitToolResult,
      }),
      makeBridge({
        supportsToolResultContinuation: true,
        submitToolResult: replacementSubmitToolResult,
      }),
    ];
    const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
      callbacks.push(request);
      const bridge = bridges[callbacks.length - 1];
      if (!bridge) {
        throw new Error("unexpected replacement bridge");
      }
      return bridge;
    });
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId: vi.fn((providerCallId: string) => makeCallRecord(providerCallId)),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const oldResult = createDeferred<{ text: string }>();
    const replacementResult = createDeferred<{ text: string }>();
    const consult = vi
      .fn()
      .mockImplementationOnce(() => oldResult.promise)
      .mockImplementationOnce(() => replacementResult.promise);
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const oldServer = await startRealtimeServer(handler);
    let replacementServer: Awaited<ReturnType<typeof startRealtimeServer>> | undefined;
    let oldWs: WebSocket | undefined;

    try {
      oldWs = await connectWs(oldServer.url);
      oldWs.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-native-old", callSid: "CA-native-old" },
        }),
      );
      await waitForRealtimeTest(() => {
        expect(callbacks).toHaveLength(1);
      });
      callbacks[0]?.onToolCall?.({
        itemId: "item-native-old",
        callId: "native-old",
        name: "openclaw_agent_consult",
        args: { question: "Check the old deployment." },
      });
      await waitForRealtimeTest(() => {
        expect(consult).toHaveBeenCalledTimes(1);
        expect(oldSubmitToolResult).toHaveBeenCalledTimes(1);
      });

      replacementServer = await startRealtimeServer(handler);
      const replacementWs = await connectWs(replacementServer.url);
      try {
        replacementWs.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-native-replacement", callSid: "CA-native-replacement" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(callbacks).toHaveLength(2);
        });
        callbacks[1]?.onToolCall?.({
          itemId: "item-native-replacement",
          callId: "native-replacement",
          name: "openclaw_agent_consult",
          args: { question: "Check the new deployment." },
        });
        await waitForRealtimeTest(() => {
          expect(consult).toHaveBeenCalledTimes(2);
        });

        oldResult.resolve({ text: "The old deployment is healthy." });
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
        expect(oldSubmitToolResult).toHaveBeenCalledTimes(1);

        replacementResult.resolve({ text: "The new deployment is healthy." });
        await waitForRealtimeTest(() => {
          expect(replacementSubmitToolResult).toHaveBeenLastCalledWith(
            "native-replacement",
            { text: "The new deployment is healthy." },
            undefined,
          );
        });
      } finally {
        if (
          replacementWs.readyState !== WebSocket.CLOSED &&
          replacementWs.readyState !== WebSocket.CLOSING
        ) {
          replacementWs.close();
        }
      }
    } finally {
      if (
        oldWs &&
        oldWs.readyState !== WebSocket.CLOSED &&
        oldWs.readyState !== WebSocket.CLOSING
      ) {
        oldWs.close();
      }
      await replacementServer?.close();
      await oldServer.close();
    }
  });

  it("does not carry a final transcript into the next direct voice turn", async () => {
    let callbacks:
      | {
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    const processEvent = vi.fn();
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return makeBridge();
      },
    );
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCallByProviderCallId: vi.fn(
          (): CallRecord => ({
            callId: "call-1",
            providerCallId: "CA-direct-turns",
            provider: "twilio",
            direction: "inbound",
            state: "ringing",
            from: "+15550001234",
            to: "+15550009999",
            startedAt: Date.now(),
            transcript: [],
            processedEventIds: [],
            metadata: {},
          }),
        ),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-direct-turns", callSid: "CA-direct-turns" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        callbacks?.onTranscript?.("user", "Hel", false);
        callbacks?.onTranscript?.("user", "lo there.", false);
        callbacks?.onTranscript?.("user", "Hello there.", true);
        callbacks?.onTranscript?.("user", "How are you?", true);
        callbacks?.onTranscript?.("user", "Hel", false);
        callbacks?.onTranscript?.("user", "lo", true);
        callbacks?.onTranscript?.("user", "hello", false);
        callbacks?.onTranscript?.("user", "hello", false);
        callbacks?.onTranscript?.("user", "hello", true);
        const longTranscript = `${"prefix ".repeat(200)}final words.`;
        callbacks?.onTranscript?.("user", longTranscript, false);
        callbacks?.onTranscript?.("user", longTranscript, true);

        const speechTranscripts = processEvent.mock.calls
          .map(([event]) => event as NormalizedEvent)
          .filter(
            (event): event is Extract<NormalizedEvent, { type: "call.speech" }> =>
              event.type === "call.speech",
          )
          .map((event) => event.transcript);
        expect(speechTranscripts).toEqual([
          "Hello there.",
          "How are you?",
          "Hello",
          "hello",
          longTranscript,
        ]);
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("waits for partial transcript fragments to settle before consulting", async () => {
    let callbacks:
      | {
          onToolCall?: (event: RealtimeVoiceToolCallEvent) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    const submitToolResult = vi.fn();
    const bridge = makeBridge({
      supportsToolResultContinuation: true,
      submitToolResult,
    });
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return bridge;
      },
    );
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId: vi.fn(
          (): CallRecord => ({
            callId: "call-1",
            providerCallId: "CA-settle",
            provider: "twilio",
            direction: "inbound",
            state: "ringing",
            from: "+15550001234",
            to: "+15550009999",
            startedAt: Date.now(),
            transcript: [],
            processedEventIds: [],
            metadata: {},
          }),
        ),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const consult = vi.fn<
      (args: unknown, callId: string, context: Record<string, unknown>) => Promise<{ text: string }>
    >(async () => ({ text: "I sent it." }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-settle", callSid: "CA-settle" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        vi.useFakeTimers();
        callbacks?.onTranscript?.("user", "Send a Discord", false);
        callbacks?.onToolCall?.({
          itemId: "item-1",
          callId: "consult-call",
          name: "openclaw_agent_consult",
          args: { question: "message" },
        });
        await vi.advanceTimersByTimeAsync(50);
        callbacks?.onTranscript?.("user", "message.", false);
        await vi.advanceTimersByTimeAsync(350);

        await waitForRealtimeTest(
          () => {
            expect(consult).toHaveBeenCalledTimes(1);
          },
          { timeout: 2_000 },
        );
        const [args, callId, context] = requireFirstMockCall(consult.mock.calls, "consult");
        const consultArgs = args as { question?: string; context?: string } | undefined;
        expect(consultArgs?.question).toBe("Send a Discord message.");
        expect(consultArgs?.context).toBe(
          "Realtime provider supplied a shorter consult question: message",
        );
        expect(callId).toBe("call-1");
        expect(context).toEqual({
          partialUserTranscript: "Send a Discord message.",
          abortSignal: expect.any(AbortSignal),
        });
        await waitForRealtimeTest(() => {
          expect(submitToolResult).toHaveBeenLastCalledWith(
            "consult-call",
            { text: "I sent it." },
            undefined,
          );
        });
      } finally {
        vi.useRealTimers();
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("does not force a duplicate consult when the realtime provider calls the consult tool", async () => {
    let callbacks:
      | {
          onToolCall?: (event: RealtimeVoiceToolCallEvent) => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    const submitToolResult = vi.fn();
    const bridge = makeBridge({
      supportsToolResultContinuation: true,
      submitToolResult,
    });
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return bridge;
      },
    );
    const handler = makeHandler(
      { consultPolicy: "always" },
      {
        manager: {
          getCallByProviderCallId: vi.fn(
            (): CallRecord => ({
              callId: "call-1",
              providerCallId: "CA-native",
              provider: "twilio",
              direction: "inbound",
              state: "ringing",
              from: "+15550001234",
              to: "+15550009999",
              startedAt: Date.now(),
              transcript: [],
              processedEventIds: [],
              metadata: {},
            }),
          ),
        },
        realtimeProvider: makeRealtimeProvider(createBridge),
      },
    );
    const consult = vi.fn(async () => ({ text: "Native consult result." }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-native", callSid: "CA-native" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        vi.useFakeTimers();
        callbacks?.onTranscript?.("user", "Send me a Discord message.", true);
        callbacks?.onToolCall?.({
          itemId: "item-1",
          callId: "consult-call",
          name: "openclaw_agent_consult",
          args: { question: "Send me a Discord message." },
        });

        await waitForRealtimeTest(() => {
          expect(submitToolResult).toHaveBeenLastCalledWith(
            "consult-call",
            { text: "Native consult result." },
            undefined,
          );
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(consult).toHaveBeenCalledTimes(1);
      } finally {
        vi.useRealTimers();
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("does not submit an interim checking result when fast context is enabled", async () => {
    let callbacks:
      | {
          onToolCall?: (event: RealtimeVoiceToolCallEvent) => void;
        }
      | undefined;
    const submitToolResult = vi.fn();
    const bridge = makeBridge({
      supportsToolResultContinuation: true,
      submitToolResult,
    });
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return bridge;
      },
    );
    const handler = makeHandler(
      {
        fastContext: {
          enabled: true,
          timeoutMs: 800,
          maxResults: 3,
          sources: ["memory", "sessions"],
          fallbackToConsult: false,
        },
      },
      {
        manager: {
          getCallByProviderCallId: vi.fn(
            (): CallRecord => ({
              callId: "call-1",
              providerCallId: "CA-fast",
              provider: "twilio",
              direction: "inbound",
              state: "ringing",
              from: "+15550001234",
              to: "+15550009999",
              startedAt: Date.now(),
              transcript: [],
              processedEventIds: [],
              metadata: {},
            }),
          ),
        },
        realtimeProvider: makeRealtimeProvider(createBridge),
      },
    );
    handler.registerToolHandler("openclaw_agent_consult", async () => ({ text: "Fast context." }));
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-fast", callSid: "CA-fast" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        callbacks?.onToolCall?.({
          itemId: "item-1",
          callId: "consult-call",
          name: "openclaw_agent_consult",
          args: { question: "What do you remember?" },
        });

        await waitForRealtimeTest(() => {
          expect(submitToolResult).toHaveBeenCalledWith(
            "consult-call",
            { text: "Fast context." },
            undefined,
          );
        });
        expect(submitToolResult).toHaveBeenCalledTimes(1);
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });
});

describe("RealtimeCallHandler websocket hardening", () => {
  it("closes realtime streams when paced outbound audio exceeds the internal queue cap", async () => {
    let sendProviderAudio: ((audio: Buffer) => void) | undefined;
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        sendProviderAudio = request.onAudio;
        return makeBridge();
      },
    );
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId: vi.fn(
          (): CallRecord => ({
            callId: "call-1",
            providerCallId: "CA-backpressure",
            provider: "twilio",
            direction: "inbound",
            state: "ringing",
            from: "+15550001234",
            to: "+15550009999",
            startedAt: Date.now(),
            transcript: [],
            processedEventIds: [],
            metadata: {},
          }),
        ),
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-backpressure", callSid: "CA-backpressure" },
          }),
        );
        await waitForRealtimeTest(() => {
          if (!sendProviderAudio) {
            throw new Error("expected realtime provider audio sender");
          }
        });

        const providerAudioSender = sendProviderAudio;
        if (!providerAudioSender) {
          throw new Error("expected realtime provider audio sender");
        }
        providerAudioSender(Buffer.alloc(8_000 * 121, 0x7f));
        const closed = await waitForClose(ws);

        expect(closed.code).toBe(1013);
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("rejects oversized pre-start frames before bridge setup", async () => {
    const createBridge = vi.fn(() => makeBridge());
    const processEvent = vi.fn();
    const getCallByProviderCallId = vi.fn();
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    const server = await startRealtimeServer(handler);

    try {
      const ws = await connectWs(server.url);
      try {
        ws.send(
          JSON.stringify({
            event: "start",
            start: {
              streamSid: "MZ-oversized",
              callSid: "CA-oversized",
              padding: "A".repeat(300 * 1024),
            },
          }),
        );

        const closed = await waitForClose(ws);

        expect(closed.code).toBe(1009);
        expect(createBridge).not.toHaveBeenCalled();
        expect(processEvent).not.toHaveBeenCalled();
        expect(getCallByProviderCallId).not.toHaveBeenCalled();
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */

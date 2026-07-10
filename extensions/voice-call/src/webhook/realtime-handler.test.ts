// Voice Call tests cover realtime handler plugin behavior.
import http from "node:http";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceForcedConsultCoordinator,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket, type RawData } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord, NormalizedEvent } from "../types.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "../websocket-test-support.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

afterEach(() => {
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

function makeHandler(
  overrides?: Partial<VoiceCallRealtimeConfig>,
  deps?: {
    manager?: Partial<CallManager>;
    provider?: Partial<VoiceCallProvider>;
    providerConfig?: Record<string, unknown>;
    realtimeProvider?: RealtimeVoiceProviderPlugin;
    resolveInstructions?: (call: CallRecord) => string;
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
  return new RealtimeCallHandler(
    config,
    {
      processEvent: vi.fn(),
      getCall: vi.fn(),
      getCallByProviderCallId: vi.fn(),
      ...deps?.manager,
    } as unknown as CallManager,
    {
      name: "twilio",
      verifyWebhook: vi.fn(),
      parseWebhookEvent: vi.fn(),
      initiateCall: vi.fn(),
      hangupCall: vi.fn(),
      playTts: vi.fn(),
      startListening: vi.fn(),
      stopListening: vi.fn(),
      getCallStatus: vi.fn(),
      ...deps?.provider,
    } as unknown as VoiceCallProvider,
    deps?.realtimeProvider ?? makeRealtimeProvider(() => makeBridge()),
    deps?.providerConfig ?? { apiKey: "test-key" },
    "/voice/webhook",
    undefined,
    deps?.resolveInstructions,
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
    urlPath: match[1],
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
    sendAudio: ReturnType<typeof vi.fn>;
    ws: WebSocket;
  }) => Promise<void>,
): Promise<void> {
  let callbacks: RealtimeBridgeRequest | undefined;
  const sendAudio = vi.fn();
  const handleBargeIn = vi.fn();
  const call = makeCallRecord(params.providerCallId);
  const createBridge = vi.fn((request: RealtimeBridgeRequest) => {
    callbacks = request;
    return makeBridge({ handleBargeIn, sendAudio });
  });
  const capabilities = params.handlesProviderBargeIn
    ? PROVIDER_BARGE_IN_CAPABILITIES
    : PROVIDER_WITH_LOCAL_BARGE_IN_CAPABILITIES;
  const handler = makeHandler(undefined, {
    manager: {
      getCallByProviderCallId: vi.fn((): CallRecord => call),
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
    handler.setPublicUrl("https://public.example/api/voice/webhook");
    const payload = handler.buildTwiMLPayload(makeRequest("/voice/webhook", "127.0.0.1:3334"));

    expect(handler.getStreamPathPattern()).toBe("/api/custom/stream/realtime");
    expect(payload.body).toMatch(
      /wss:\/\/public\.example\/api\/custom\/stream\/realtime\/[0-9a-f-]{36}/,
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
      urlPath: match[1],
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
    const createBridge = vi.fn((_request: RealtimeBridgeRequest) => makeBridge());
    const handler = makeHandler(undefined, {
      manager: {
        processEvent,
        getCall,
      },
      provider: {
        name: "telnyx",
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
      provider: {
        name: "telnyx",
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
      provider: {
        name: "telnyx",
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

  it("ends realtime calls when the telephony stream stops", async () => {
    let callbacks:
      | {
          onClose?: (reason: "completed" | "error") => void;
          onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
        }
      | undefined;
    const processEvent = vi.fn();
    const close = vi.fn(() => {
      callbacks?.onTranscript?.("user", "last words", true);
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
            start: { streamSid: "MZ-complete", callSid: "CA-complete" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        ws.send(JSON.stringify({ event: "stop" }));

        await waitForRealtimeTest(() => {
          const events = processEvent.mock.calls.map(([event]) => event as NormalizedEvent);
          const ended = events.find((event) => event.type === "call.ended");
          if (ended?.type !== "call.ended") {
            throw new Error("expected realtime stop to emit call.ended");
          }
          expect(ended.callId).toBe("call-1");
          expect(ended.providerCallId).toBe("CA-complete");
          expect(ended.reason).toBe("completed");
          const speechIndex = events.findIndex((event) => event.type === "call.speech");
          const endedIndex = events.findIndex((event) => event.type === "call.ended");
          expect(speechIndex).toBeGreaterThanOrEqual(0);
          expect(speechIndex).toBeLessThan(endedIndex);
        });

        const wsClosed = waitForClose(ws);
        ws.close();
        await wsClosed;
        expect(close).toHaveBeenCalledTimes(1);
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
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
    const coordinator = (
      handler as unknown as {
        forcedConsultCoordinator(callId: string): RealtimeVoiceForcedConsultCoordinator;
      }
    ).forcedConsultCoordinator(call.callId);
    const cancelled = coordinator.prepare("cancelled question");
    if (!cancelled) {
      throw new Error("expected forced consult handle");
    }
    coordinator.markStarted(cancelled);
    coordinator.markCancelled(cancelled);
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
        });

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
        expect(context).toEqual({});
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
        expect(context).toEqual({ partialUserTranscript: "Send a Discord message." });
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

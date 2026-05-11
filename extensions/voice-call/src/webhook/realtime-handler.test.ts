import http from "node:http";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
  RealtimeVoiceToolCallEvent,
} from "openclaw/plugin-sdk/realtime-voice";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
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
): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge,
  };
}

function makeHandler(
  overrides?: Partial<VoiceCallRealtimeConfig>,
  deps?: {
    manager?: Partial<CallManager>;
    provider?: Partial<VoiceCallProvider>;
    realtimeProvider?: RealtimeVoiceProviderPlugin;
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
      includeSystemPrompt: true,
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
    { apiKey: "test-key" },
    "/voice/webhook",
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

async function waitForRealtimeTest(
  callback: () => void | Promise<void>,
  options: { timeout?: number; interval?: number } = {},
) {
  await vi.waitFor(callback, { interval: 1, ...options });
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
        const event = processEvent.mock.calls[0]?.[0] as NormalizedEvent | undefined;
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
        }
      | undefined;
    const processEvent = vi.fn();
    const createBridge = vi.fn(
      (request: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0]) => {
        callbacks = request;
        return makeBridge({
          close: () => {
            callbacks?.onClose?.("completed");
          },
        });
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
          expect(ended).toBeDefined();
          if (ended?.type !== "call.ended") {
            throw new Error("expected realtime stop to emit call.ended");
          }
          expect(ended.callId).toBe("call-1");
          expect(ended.providerCallId).toBe("CA-complete");
          expect(ended.reason).toBe("completed");
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
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
    }
  });

  it("emits barge-in cancellation with a turn before provider speech_started", async () => {
    let callbacks:
      | {
          onAudio?: (audio: Buffer) => void;
        }
      | undefined;
    const sendAudio = vi.fn();
    const call: CallRecord = {
      callId: "call-1",
      providerCallId: "CA-barge-in",
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
            start: { streamSid: "MZ-barge-in", callSid: "CA-barge-in" },
          }),
        );
        await waitForRealtimeTest(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        callbacks?.onAudio?.(Buffer.from([1, 2, 3]));
        const speechPayload = Buffer.alloc(160, 0x00).toString("base64");
        ws.send(JSON.stringify({ event: "media", media: { payload: speechPayload } }));
        ws.send(JSON.stringify({ event: "media", media: { payload: speechPayload } }));

        await waitForRealtimeTest(() => {
          expect(sendAudio).toHaveBeenCalledTimes(2);
        });

        const recent = call.metadata?.recentTalkEvents as
          | Array<{
              turnId?: string;
              type: string;
            }>
          | undefined;
        const cancelled = recent?.find((event) => event.type === "turn.cancelled");
        if (!cancelled) {
          throw new Error("expected barge-in to cancel the active turn");
        }
        expect(cancelled.turnId).toMatch(/^turn-\d+$/);
        expect(recent?.findLast((event) => event.type === "input.audio.delta")?.turnId).not.toBe(
          cancelled.turnId,
        );
      } finally {
        if (ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
          ws.close();
        }
      }
    } finally {
      await server.close();
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
    let receivedPartialTranscript: string | undefined;
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
    const getCallByProviderCallId = vi.fn(
      (): CallRecord => ({
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
      }),
    );
    const handler = makeHandler(undefined, {
      manager: {
        getCallByProviderCallId,
      },
      realtimeProvider: makeRealtimeProvider(createBridge),
    });
    handler.registerToolHandler("openclaw_agent_consult", (_args, _callId, context) => {
      receivedPartialTranscript = context.partialUserTranscript;
      return new Promise((resolve) => {
        resolveConsult = resolve;
      });
    });
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
        await vi.advanceTimersByTimeAsync(350);
        await waitForRealtimeTest(() => {
          expect(receivedPartialTranscript).toBe("Are the basement");
        });

        await waitForRealtimeTest(() => {
          const workingCall = submitToolResult.mock.calls.find(
            ([callId]) => callId === "consult-call",
          );
          expect(workingCall).toBeDefined();
          const payload = workingCall?.[1] as Record<string, unknown> | undefined;
          expect(payload?.status).toBe("working");
          expect(payload?.tool).toBe("openclaw_agent_consult");
          expect(typeof payload?.message).toBe("string");
          expect(workingCall?.[2]).toEqual({ willContinue: true });
        });
        expect(submitToolResult).toHaveBeenCalledTimes(1);

        resolveConsult?.({ text: "The basement lights are on." });

        await waitForRealtimeTest(() => {
          expect(submitToolResult).toHaveBeenLastCalledWith(
            "consult-call",
            {
              text: "The basement lights are on.",
            },
            undefined,
          );
        });

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
        const [args, callId, context] = consult.mock.calls[0] ?? [];
        expect(args).toEqual({
          question: "Create a smoke test file for me.",
          context:
            "The realtime provider produced a final user transcript without invoking openclaw_agent_consult, so OpenClaw is forcing the consult because consultPolicy is always.",
        });
        expect(callId).toBe("call-1");
        expect(context).toEqual({});
        await waitForRealtimeTest(() => {
          expect(sendUserMessage).toHaveBeenCalledWith(
            expect.stringContaining("I created the smoke test file."),
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

        callbacks?.onTranscript?.("user", "Hello there.", true);
        callbacks?.onTranscript?.("user", "How are you?", true);

        const speechTranscripts = processEvent.mock.calls
          .map(([event]) => event as NormalizedEvent)
          .filter(
            (event): event is Extract<NormalizedEvent, { type: "call.speech" }> =>
              event.type === "call.speech",
          )
          .map((event) => event.transcript);
        expect(speechTranscripts).toContain("Hello there.");
        expect(speechTranscripts).toContain("How are you?");
        expect(speechTranscripts).not.toContain("Hello there. How are you?");
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
        const [args, callId, context] = consult.mock.calls[0] ?? [];
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

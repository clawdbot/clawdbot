import http from "node:http";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord } from "../types.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "../websocket-test-support.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

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
    tools: overrides?.tools ?? [],
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
        await vi.waitFor(() => {
          expect(createBridge).toHaveBeenCalled();
        });
        callbacks?.onReady?.();
        expect(processEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            type: "call.initiated",
            direction: "outbound",
            from: "+15550001234",
            to: "+15550009999",
          }),
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
        }
      | undefined;
    let resolveConsult: ((value: unknown) => void) | undefined;
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
    handler.registerToolHandler(
      "openclaw_agent_consult",
      () =>
        new Promise((resolve) => {
          resolveConsult = resolve;
        }),
    );
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
        await vi.waitFor(() => {
          expect(createBridge).toHaveBeenCalled();
        });

        callbacks?.onToolCall?.({
          itemId: "item-1",
          callId: "consult-call",
          name: "openclaw_agent_consult",
          args: { question: "Are the basement lights on?" },
        });

        await vi.waitFor(() => {
          expect(submitToolResult).toHaveBeenCalledWith(
            "consult-call",
            expect.objectContaining({
              status: "working",
              tool: "openclaw_agent_consult",
            }),
            { willContinue: true },
          );
        });
        expect(submitToolResult).toHaveBeenCalledTimes(1);

        resolveConsult?.({ text: "The basement lights are on." });

        await vi.waitFor(() => {
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

        await vi.waitFor(() => {
          expect(submitToolResult).toHaveBeenCalledWith("custom-call", { ok: true }, undefined);
        });
        expect(submitToolResult).not.toHaveBeenCalledWith("custom-call", expect.anything(), {
          willContinue: true,
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
});

describe("RealtimeCallHandler websocket hardening", () => {
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

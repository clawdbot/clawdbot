import type { RealtimeVoiceBridge } from "openclaw/plugin-sdk/realtime-voice";
import { describe, expect, it, vi } from "vitest";
import type { WebSocket as WebSocketType } from "ws";
import { WebSocket } from "ws";
import type { VoiceCallRealtimeConfig } from "../config.js";
import type { CallManager } from "../manager.js";
import type { VoiceCallProvider } from "../providers/base.js";
import type { CallRecord } from "../types.js";
import { connectWs, startUpgradeWsServer, waitForClose } from "../websocket-test-support.js";
import { RealtimeCallHandler } from "./realtime-handler.js";

function createRealtimeConfig(): VoiceCallRealtimeConfig {
  return {
    enabled: true,
    streamPath: "/voice/stream/realtime",
    instructions: "Be helpful.",
    toolPolicy: "safe-read-only",
    consultPolicy: "auto",
    tools: [],
    fastContext: {
      enabled: false,
      timeoutMs: 800,
      maxResults: 3,
      sources: ["memory", "sessions"],
      fallbackToConsult: false,
    },
    agentContext: {
      enabled: false,
      maxChars: 6000,
      includeIdentity: true,
      includeWorkspaceFiles: true,
      files: ["SOUL.md", "IDENTITY.md", "USER.md"],
    },
    providers: {},
  };
}

function createBridge(
  close: () => void,
  overrides: Partial<RealtimeVoiceBridge> = {},
): RealtimeVoiceBridge {
  return {
    connect: async () => {},
    sendAudio: () => {},
    setMediaTimestamp: () => {},
    submitToolResult: () => {},
    acknowledgeMark: () => {},
    close,
    isConnected: () => true,
    triggerGreeting: () => {},
    ...overrides,
  };
}

describe("RealtimeCallHandler lifecycle", () => {
  it("terminates active sockets and treats server shutdown as completed", async () => {
    const bridgeClose = vi.fn();
    const createBridgeForCall = vi.fn(() => createBridge(bridgeClose));
    const processEvent = vi.fn();
    const call: CallRecord = {
      callId: "call-shutdown",
      providerCallId: "CA-shutdown",
      provider: "twilio",
      direction: "inbound",
      state: "ringing",
      from: "+15550001111",
      to: "+15550002222",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
    };
    const handler = new RealtimeCallHandler(
      createRealtimeConfig(),
      {
        processEvent,
        getCallByProviderCallId: vi.fn(() => call),
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
      } as unknown as VoiceCallProvider,
      {
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
        createBridge: createBridgeForCall,
      },
      { apiKey: "test-key" },
      "/voice/webhook",
    );
    const { streamUrl } = handler.issueStreamSession();
    const server = await startUpgradeWsServer({
      urlPath: new URL(streamUrl).pathname,
      onUpgrade: (request, socket, head) => {
        handler.handleWebSocketUpgrade(request, socket, head);
      },
    });
    let ws: WebSocketType | null = await connectWs(server.url);
    let releaseShutdownBarrier: (() => void) | undefined;

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-shutdown", callSid: "CA-shutdown" },
        }),
      );
      await vi.waitFor(() => {
        expect(createBridgeForCall).toHaveBeenCalledTimes(1);
      });

      const closed = waitForClose(ws);
      const shutdownBarrier = new Promise<void>((resolve) => {
        releaseShutdownBarrier = resolve;
      });
      const firstClose = handler.close(shutdownBarrier);
      const secondClose = handler.close();
      handler.issueStreamSession();
      let closeSettled = false;
      void firstClose.then(() => {
        closeSettled = true;
      });

      expect(secondClose).toBe(firstClose);
      expect(await closed).toEqual({ code: 1006, reason: "" });
      await vi.waitFor(() => {
        expect(bridgeClose).toHaveBeenCalledTimes(1);
        expect(processEvent).toHaveBeenCalledWith(
          expect.objectContaining({
            callId: "call-shutdown",
            providerCallId: "CA-shutdown",
            reason: "completed",
            type: "call.ended",
          }),
        );
      });
      expect(closeSettled).toBe(false);

      releaseShutdownBarrier?.();
      await firstClose;
      expect(closeSettled).toBe(true);
      expect(
        (
          handler as unknown as {
            pendingStreamTokens: Map<string, unknown>;
          }
        ).pendingStreamTokens.size,
      ).toBe(0);
      ws = null;
    } finally {
      releaseShutdownBarrier?.();
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });

  it("tolerates provider close during bridge creation", async () => {
    const bridgeConnect = vi.fn(async () => {});
    const createBridgeForCall = vi.fn(
      (request: { onClose?: (reason: "completed" | "error") => void }) => {
        request.onClose?.("completed");
        return createBridge(vi.fn(), { connect: bridgeConnect });
      },
    );
    const call: CallRecord = {
      callId: "call-synchronous-close",
      providerCallId: "CA-synchronous-close",
      provider: "twilio",
      direction: "inbound",
      state: "ringing",
      from: "+15550001111",
      to: "+15550002222",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
    };
    const handler = new RealtimeCallHandler(
      createRealtimeConfig(),
      {
        processEvent: vi.fn(),
        getCallByProviderCallId: vi.fn(() => call),
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
      } as unknown as VoiceCallProvider,
      {
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
        createBridge: createBridgeForCall,
      },
      { apiKey: "test-key" },
      "/voice/webhook",
    );
    const { streamUrl } = handler.issueStreamSession();
    const server = await startUpgradeWsServer({
      urlPath: new URL(streamUrl).pathname,
      onUpgrade: (request, socket, head) => {
        handler.handleWebSocketUpgrade(request, socket, head);
      },
    });
    const ws = await connectWs(server.url);

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-synchronous-close", callSid: "CA-synchronous-close" },
        }),
      );
      await vi.waitFor(() => {
        expect(createBridgeForCall).toHaveBeenCalledTimes(1);
        expect(bridgeConnect).toHaveBeenCalledTimes(1);
      });
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });

  it("does not start a native consult after teardown during transcript settling", async () => {
    let onToolCall:
      | ((event: { itemId: string; callId: string; name: string; args: unknown }) => void)
      | undefined;
    let onTranscript:
      | ((role: "user" | "assistant", text: string, isFinal: boolean) => void)
      | undefined;
    const submitToolResult = vi.fn();
    const createBridgeForCall = vi.fn(
      (request: {
        onToolCall?: (event: {
          itemId: string;
          callId: string;
          name: string;
          args: unknown;
        }) => void;
        onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
      }) => {
        onToolCall = request.onToolCall;
        onTranscript = request.onTranscript;
        return createBridge(vi.fn(), {
          supportsToolResultContinuation: true,
          submitToolResult,
        });
      },
    );
    const call: CallRecord = {
      callId: "call-settling-consult",
      providerCallId: "CA-settling-consult",
      provider: "twilio",
      direction: "inbound",
      state: "ringing",
      from: "+15550001111",
      to: "+15550002222",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
    };
    const handler = new RealtimeCallHandler(
      createRealtimeConfig(),
      {
        processEvent: vi.fn(),
        getCallByProviderCallId: vi.fn(() => call),
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
      } as unknown as VoiceCallProvider,
      {
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
        createBridge: createBridgeForCall,
      },
      { apiKey: "test-key" },
      "/voice/webhook",
    );
    const consult = vi.fn(async () => ({ text: "This should not run." }));
    handler.registerToolHandler("openclaw_agent_consult", consult);
    const { streamUrl } = handler.issueStreamSession();
    const server = await startUpgradeWsServer({
      urlPath: new URL(streamUrl).pathname,
      onUpgrade: (request, socket, head) => {
        handler.handleWebSocketUpgrade(request, socket, head);
      },
    });
    const ws = await connectWs(server.url);

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-settling-consult", callSid: "CA-settling-consult" },
        }),
      );
      await vi.waitFor(() => {
        expect(createBridgeForCall).toHaveBeenCalledTimes(1);
      });

      onTranscript?.("user", "Check the deployment", false);
      onToolCall?.({
        itemId: "item-settling-consult",
        callId: "tool-settling-consult",
        name: "openclaw_agent_consult",
        args: { question: "Check the deployment." },
      });
      const consults = (
        handler as unknown as {
          nativeConsultsInFlightByCallId: Map<string, unknown>;
        }
      ).nativeConsultsInFlightByCallId;
      await vi.waitFor(() => {
        expect(consults.size).toBe(1);
        expect(submitToolResult).toHaveBeenCalledTimes(1);
        expect(consult).not.toHaveBeenCalled();
      });

      const closed = waitForClose(ws);
      ws.close();
      await closed;
      await vi.waitFor(() => {
        expect(consults.size).toBe(0);
      });
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 400);
      });

      expect(consult).not.toHaveBeenCalled();
      expect(submitToolResult).toHaveBeenCalledTimes(1);
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });

  it("releases a hung native consult and ignores its late result after stream teardown", async () => {
    let onToolCall:
      | ((event: { itemId: string; callId: string; name: string; args: unknown }) => void)
      | undefined;
    let resolveConsult: ((result: unknown) => void) | undefined;
    const submitToolResult = vi.fn();
    const createBridgeForCall = vi.fn(
      (request: {
        onToolCall?: (event: {
          itemId: string;
          callId: string;
          name: string;
          args: unknown;
        }) => void;
      }) => {
        onToolCall = request.onToolCall;
        return createBridge(vi.fn(), {
          supportsToolResultContinuation: true,
          submitToolResult,
        });
      },
    );
    const call: CallRecord = {
      callId: "call-consult",
      providerCallId: "CA-consult",
      provider: "twilio",
      direction: "inbound",
      state: "ringing",
      from: "+15550001111",
      to: "+15550002222",
      startedAt: Date.now(),
      transcript: [],
      processedEventIds: [],
    };
    const handler = new RealtimeCallHandler(
      createRealtimeConfig(),
      {
        processEvent: vi.fn(),
        getCallByProviderCallId: vi.fn(() => call),
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
      } as unknown as VoiceCallProvider,
      {
        id: "openai",
        label: "OpenAI",
        isConfigured: () => true,
        createBridge: createBridgeForCall,
      },
      { apiKey: "test-key" },
      "/voice/webhook",
    );
    handler.registerToolHandler(
      "openclaw_agent_consult",
      async () =>
        await new Promise<unknown>((resolve) => {
          resolveConsult = resolve;
        }),
    );
    const { streamUrl } = handler.issueStreamSession();
    const server = await startUpgradeWsServer({
      urlPath: new URL(streamUrl).pathname,
      onUpgrade: (request, socket, head) => {
        handler.handleWebSocketUpgrade(request, socket, head);
      },
    });
    const ws = await connectWs(server.url);

    try {
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-consult", callSid: "CA-consult" },
        }),
      );
      await vi.waitFor(() => {
        expect(createBridgeForCall).toHaveBeenCalledTimes(1);
      });

      onToolCall?.({
        itemId: "item-consult",
        callId: "tool-consult",
        name: "openclaw_agent_consult",
        args: { question: "Check the deployment." },
      });
      await vi.waitFor(() => {
        expect(resolveConsult).toBeTypeOf("function");
      });

      const consults = (
        handler as unknown as {
          nativeConsultsInFlightByCallId: Map<string, unknown>;
        }
      ).nativeConsultsInFlightByCallId;
      expect(consults.size).toBe(1);

      const closed = waitForClose(ws);
      ws.close();
      await closed;
      await vi.waitFor(() => {
        expect(consults.size).toBe(0);
      });

      resolveConsult?.({ text: "Deployment is healthy." });
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(submitToolResult).toHaveBeenCalledTimes(1);
      expect(submitToolResult).not.toHaveBeenCalledWith(
        "tool-consult",
        { text: "Deployment is healthy." },
        undefined,
      );
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });
});

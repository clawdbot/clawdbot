import type {
  RealtimeVoiceBridge,
  RealtimeVoiceProviderPlugin,
} from "openclaw/plugin-sdk/realtime-voice";
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

function makeRealtimeProvider(
  createBridgeForCall: RealtimeVoiceProviderPlugin["createBridge"],
): RealtimeVoiceProviderPlugin {
  return {
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
    createBridge: createBridgeForCall,
  };
}

function makeCallRegistrationResolver(
  provider: RealtimeVoiceProviderPlugin,
): ConstructorParameters<typeof RealtimeCallHandler>[3] {
  return (call) => ({
    agentId: call.agentId ?? "main",
    instructions: "Be helpful.",
    provider,
    providerConfig: { apiKey: "test-key" },
  });
}

function createCarrierLifecycleHarness(
  createBridgeForCall: RealtimeVoiceProviderPlugin["createBridge"],
  options: {
    initialMessage?: string;
    resolveCallRegistration?: ConstructorParameters<typeof RealtimeCallHandler>[3];
  } = {},
) {
  const realtimeProvider = makeRealtimeProvider(createBridgeForCall);
  const call: CallRecord = {
    callId: "call-startup",
    providerCallId: "CA-startup",
    provider: "twilio",
    direction: "inbound",
    state: "ringing",
    from: "+15550001111",
    to: "+15550002222",
    startedAt: Date.now(),
    transcript: [],
    processedEventIds: [],
    ...(options.initialMessage ? { metadata: { initialMessage: options.initialMessage } } : {}),
  };
  const processEvent = vi.fn();
  const hangupCall = vi.fn(async () => {});
  const handler = new RealtimeCallHandler(
    createRealtimeConfig(),
    {
      processEvent,
      getCallByProviderCallId: vi.fn(() => call),
    } as unknown as CallManager,
    { name: "twilio", hangupCall } as unknown as VoiceCallProvider,
    options.resolveCallRegistration ?? makeCallRegistrationResolver(realtimeProvider),
    "/voice/webhook",
  );
  return { call, handler, hangupCall, processEvent };
}

async function connectCarrierStream(handler: RealtimeCallHandler) {
  const { streamUrl } = handler.issueStreamSession();
  const server = await startUpgradeWsServer({
    urlPath: new URL(streamUrl).pathname,
    onUpgrade: (request, socket, head) => {
      handler.handleWebSocketUpgrade(request, socket, head);
    },
  });
  return { server, ws: await connectWs(server.url) };
}

describe("RealtimeCallHandler lifecycle", () => {
  it.each([
    { closeOutcome: undefined, closeReason: "Failed to connect" },
    { closeOutcome: "completed" as const, closeReason: "Failed to connect" },
    { closeOutcome: "error" as const, closeReason: "Bridge disconnected" },
    { closeOutcome: "throws" as const, closeReason: "Failed to connect" },
  ])(
    "hangs up a rejected startup exactly once when provider close is $closeOutcome",
    async ({ closeOutcome, closeReason }) => {
      let onProviderClose: ((reason: "completed" | "error") => void) | undefined;
      const closeBridge = vi.fn(() => {
        if (closeOutcome === "throws") {
          throw new Error("realtime provider close failed");
        }
        if (closeOutcome) {
          onProviderClose?.(closeOutcome);
        }
      });
      const { call, handler, hangupCall, processEvent } = createCarrierLifecycleHarness(
        (request) => {
          onProviderClose = request.onClose;
          return createBridge(closeBridge, {
            connect: async () => {
              throw new Error("realtime provider rejected startup");
            },
          });
        },
      );
      const { server, ws } = await connectCarrierStream(handler);

      try {
        const closed = waitForClose(ws);
        ws.send(
          JSON.stringify({
            event: "start",
            start: { streamSid: "MZ-startup", callSid: call.providerCallId },
          }),
        );

        expect(await closed).toEqual({ code: 1011, reason: closeReason });
        expect(closeBridge).toHaveBeenCalledTimes(1);
        expect(hangupCall).toHaveBeenCalledExactlyOnceWith({
          callId: call.callId,
          providerCallId: call.providerCallId,
          reason: "error",
        });
        const endedEvents = processEvent.mock.calls.filter(
          ([event]) => event.type === "call.ended",
        );
        expect(endedEvents).toHaveLength(1);
        expect(endedEvents[0]?.[0]).toEqual(
          expect.objectContaining({
            callId: call.callId,
            providerCallId: call.providerCallId,
            reason: "error",
          }),
        );
        expect(handler.speak(call.callId, "still connected")).toEqual({
          success: false,
          error: "No active realtime bridge for call",
        });
      } finally {
        if (ws.readyState !== WebSocket.CLOSED) {
          ws.terminate();
        }
        await handler.close();
        await server.close();
      }
    },
  );

  it("hangs up the carrier when its initial realtime bridge cannot be created", async () => {
    const { call, handler, hangupCall, processEvent } = createCarrierLifecycleHarness(() => {
      throw new Error("realtime provider rejected call configuration");
    });
    const { server, ws } = await connectCarrierStream(handler);

    try {
      const closed = waitForClose(ws);
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-initial-creation", callSid: call.providerCallId },
        }),
      );

      expect(await closed).toEqual({ code: 1011, reason: "Failed to create realtime bridge" });
      expect(hangupCall).toHaveBeenCalledExactlyOnceWith({
        callId: call.callId,
        providerCallId: call.providerCallId,
        reason: "error",
      });
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        1,
      );
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });

  it("ends an initial call when routed realtime admission fails", async () => {
    const createBridgeForCall = vi.fn<RealtimeVoiceProviderPlugin["createBridge"]>();
    const resolveCallRegistration = vi.fn(() => {
      throw new Error("routed agent realtime is unavailable");
    });
    const { call, handler, hangupCall, processEvent } = createCarrierLifecycleHarness(
      createBridgeForCall,
      {
        initialMessage: "Hello from the routed agent.",
        resolveCallRegistration,
      },
    );
    const { server, ws } = await connectCarrierStream(handler);

    try {
      const closed = waitForClose(ws);
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-admission-failure", callSid: call.providerCallId },
        }),
      );

      expect(await closed).toEqual({
        code: 1011,
        reason: "Check realtime configuration for routed agent",
      });
      expect(resolveCallRegistration).toHaveBeenCalledExactlyOnceWith(call);
      expect(createBridgeForCall).not.toHaveBeenCalled();
      expect(processEvent.mock.calls.map(([event]) => event.type)).toEqual([
        "call.initiated",
        "call.ended",
      ]);
      expect(processEvent.mock.calls.at(-1)?.[0]).toEqual(
        expect.objectContaining({
          callId: call.callId,
          providerCallId: call.providerCallId,
          reason: "error",
        }),
      );
      expect(hangupCall).toHaveBeenCalledExactlyOnceWith({
        callId: call.callId,
        providerCallId: call.providerCallId,
        reason: "error",
      });
      expect(call.metadata?.initialMessage).toBe("Hello from the routed agent.");
      expect(handler.speak(call.callId, "still connected")).toEqual({
        success: false,
        error: "No active realtime bridge for call",
      });
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });

  it("preserves the active predecessor when replacement admission fails", async () => {
    const predecessorGreeting = vi.fn();
    const realtimeProvider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      isConfigured: () => true,
      createBridge: vi.fn(() =>
        createBridge(vi.fn(), {
          triggerGreeting: predecessorGreeting,
        }),
      ),
    };
    const resolveCallRegistration = vi
      .fn<ConstructorParameters<typeof RealtimeCallHandler>[3]>()
      .mockReturnValueOnce({
        agentId: "main",
        instructions: "Be helpful.",
        provider: realtimeProvider,
        providerConfig: { apiKey: "test-key" },
      })
      .mockImplementationOnce(() => {
        throw new Error("replacement agent realtime is unavailable");
      });
    const { call, handler, hangupCall, processEvent } = createCarrierLifecycleHarness(
      realtimeProvider.createBridge,
      { resolveCallRegistration },
    );
    const predecessor = await connectCarrierStream(handler);
    let replacement: Awaited<ReturnType<typeof connectCarrierStream>> | undefined;

    try {
      predecessor.ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-predecessor", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(realtimeProvider.createBridge).toHaveBeenCalledTimes(1));

      replacement = await connectCarrierStream(handler);
      const replacementClosed = waitForClose(replacement.ws);
      replacement.ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-replacement-admission", callSid: call.providerCallId },
        }),
      );

      expect(await replacementClosed).toEqual({
        code: 1011,
        reason: "Check realtime configuration for routed agent",
      });
      expect(resolveCallRegistration).toHaveBeenCalledTimes(2);
      expect(realtimeProvider.createBridge).toHaveBeenCalledTimes(1);
      expect(
        processEvent.mock.calls.filter(([event]) => event.type === "call.answered"),
      ).toHaveLength(1);
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        0,
      );
      expect(hangupCall).not.toHaveBeenCalled();
      expect(predecessor.ws.readyState).toBe(WebSocket.OPEN);
      expect(handler.speak(call.callId, "predecessor remains connected")).toEqual({
        success: true,
      });
      expect(predecessorGreeting).toHaveBeenCalledWith("predecessor remains connected");
    } finally {
      if (predecessor.ws.readyState !== WebSocket.CLOSED) {
        predecessor.ws.terminate();
      }
      if (replacement && replacement.ws.readyState !== WebSocket.CLOSED) {
        replacement.ws.terminate();
      }
      await handler.close();
      await replacement?.server.close();
      await predecessor.server.close();
    }
  });

  it("does not hang up a replacement when its stale predecessor rejects startup", async () => {
    let rejectStartup: (error: Error) => void = () => {};
    const pendingStartup = new Promise<void>((_resolve, reject) => {
      rejectStartup = reject;
    });
    const replacementGreeting = vi.fn();
    const createBridgeForCall = vi
      .fn<RealtimeVoiceProviderPlugin["createBridge"]>()
      .mockImplementationOnce(() => createBridge(vi.fn(), { connect: () => pendingStartup }))
      .mockImplementationOnce(() =>
        createBridge(vi.fn(), { triggerGreeting: replacementGreeting }),
      );
    const { call, handler, hangupCall, processEvent } =
      createCarrierLifecycleHarness(createBridgeForCall);
    const previous = await connectCarrierStream(handler);
    let replacement: Awaited<ReturnType<typeof connectCarrierStream>> | undefined;

    try {
      previous.ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-previous", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledTimes(1));

      replacement = await connectCarrierStream(handler);
      replacement.ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-replacement", callSid: call.providerCallId },
        }),
      );
      await vi.waitFor(() => expect(createBridgeForCall).toHaveBeenCalledTimes(2));

      const previousClosed = waitForClose(previous.ws);
      rejectStartup(new Error("superseded provider rejected startup"));
      expect(await previousClosed).toEqual({ code: 1011, reason: "Failed to connect" });
      expect(hangupCall).not.toHaveBeenCalled();
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        0,
      );
      expect(replacement.ws.readyState).toBe(WebSocket.OPEN);
      expect(handler.speak(call.callId, "replacement remains connected")).toEqual({
        success: true,
      });
      expect(replacementGreeting).toHaveBeenCalledWith("replacement remains connected");
    } finally {
      if (previous.ws.readyState !== WebSocket.CLOSED) {
        previous.ws.terminate();
      }
      if (replacement?.ws.readyState !== WebSocket.CLOSED) {
        replacement?.ws.terminate();
      }
      await handler.close();
      await replacement?.server.close();
      await previous.server.close();
    }
  });

  it("ends an idle realtime call after the media inactivity grace", async () => {
    let resolveBridgeStarted = () => {};
    const bridgeStarted = new Promise<void>((resolve) => {
      resolveBridgeStarted = resolve;
    });
    const closeBridge = vi.fn();
    const { call, handler, hangupCall, processEvent } = createCarrierLifecycleHarness(() => {
      resolveBridgeStarted();
      return createBridge(closeBridge);
    });
    const { server, ws } = await connectCarrierStream(handler);

    try {
      vi.useFakeTimers();
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-inactivity", callSid: call.providerCallId },
        }),
      );
      await bridgeStarted;

      await vi.advanceTimersByTimeAsync(30_000);
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        0,
      );
      await vi.advanceTimersByTimeAsync(1_999);
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        0,
      );
      await vi.advanceTimersByTimeAsync(1);

      expect(closeBridge).toHaveBeenCalledOnce();
      expect(processEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: call.callId,
          providerCallId: call.providerCallId,
          reason: "timeout",
          type: "call.ended",
        }),
      );
      expect(hangupCall).toHaveBeenCalledExactlyOnceWith({
        callId: call.callId,
        providerCallId: call.providerCallId,
        reason: "timeout",
      });
    } finally {
      vi.useRealTimers();
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });

  it("renews realtime liveness when inbound media continues", async () => {
    let resolveBridgeStarted = () => {};
    const bridgeStarted = new Promise<void>((resolve) => {
      resolveBridgeStarted = resolve;
    });
    let resolveMediaReceived = () => {};
    const mediaReceived = new Promise<void>((resolve) => {
      resolveMediaReceived = resolve;
    });
    const sendAudio = vi.fn(() => resolveMediaReceived());
    const { call, handler, hangupCall, processEvent } = createCarrierLifecycleHarness(() => {
      resolveBridgeStarted();
      return createBridge(vi.fn(), { sendAudio });
    });
    const { server, ws } = await connectCarrierStream(handler);

    try {
      vi.useFakeTimers();
      ws.send(
        JSON.stringify({
          event: "start",
          start: { streamSid: "MZ-active-media", callSid: call.providerCallId },
        }),
      );
      await bridgeStarted;

      await vi.advanceTimersByTimeAsync(29_999);
      ws.send(
        JSON.stringify({
          event: "media",
          media: { payload: Buffer.from([0xff]).toString("base64") },
        }),
      );
      await mediaReceived;
      await vi.advanceTimersByTimeAsync(29_999);

      expect(sendAudio).toHaveBeenCalledOnce();
      expect(processEvent.mock.calls.filter(([event]) => event.type === "call.ended")).toHaveLength(
        0,
      );
      expect(hangupCall).not.toHaveBeenCalled();
      expect(ws.readyState).toBe(WebSocket.OPEN);
    } finally {
      vi.useRealTimers();
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });

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
      makeCallRegistrationResolver(makeRealtimeProvider(createBridgeForCall)),
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
      makeCallRegistrationResolver(makeRealtimeProvider(createBridgeForCall)),
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
      makeCallRegistrationResolver(makeRealtimeProvider(createBridgeForCall)),
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

  it("aborts a hung native consult during stream teardown", async () => {
    let onToolCall:
      | ((event: { itemId: string; callId: string; name: string; args: unknown }) => void)
      | undefined;
    let consultSignal: AbortSignal | undefined;
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
      makeCallRegistrationResolver(makeRealtimeProvider(createBridgeForCall)),
      "/voice/webhook",
    );
    handler.registerToolHandler("openclaw_agent_consult", async (_args, _callId, context) => {
      consultSignal = context.abortSignal;
      return await new Promise<unknown>((_resolve, reject) => {
        context.abortSignal?.addEventListener(
          "abort",
          () => reject(new Error("native consult aborted", { cause: context.abortSignal?.reason })),
          { once: true },
        );
      });
    });
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
        expect(consultSignal).toBeDefined();
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

      expect(consultSignal?.aborted).toBe(true);
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(submitToolResult).toHaveBeenCalledTimes(1);
    } finally {
      if (ws.readyState !== WebSocket.CLOSED) {
        ws.terminate();
      }
      await handler.close();
      await server.close();
    }
  });
});

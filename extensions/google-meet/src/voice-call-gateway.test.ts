// Google Meet tests cover voice call gateway plugin behavior.
import { createServer } from "node:http";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import {
  createVoiceCallGateway,
  endMeetVoiceCallGatewayCall,
  getMeetVoiceCallGatewayCall,
  joinMeetViaVoiceCallGateway,
} from "./voice-call-gateway.js";

type GatewayRuntime = typeof import("openclaw/plugin-sdk/gateway-runtime");
type GatewayClientOptions = ConstructorParameters<GatewayRuntime["GatewayClient"]>[0];
type GatewayClientInstance = InstanceType<GatewayRuntime["GatewayClient"]>;

const gatewayMocks = vi.hoisted(() => ({
  runtimeRequest: vi.fn(),
  request: vi.fn(),
  stopAndWait: vi.fn(async () => {}),
  startGatewayClientWhenEventLoopReady: vi.fn(
    async (_client: unknown, _options?: { signal?: AbortSignal }) => ({
      ready: true,
      aborted: false,
    }),
  ),
  autoHello: true,
  clientOptions: undefined as GatewayClientOptions | undefined,
  constructorError: undefined as Error | undefined,
  actualGatewayClient: undefined as GatewayRuntime["GatewayClient"] | undefined,
  actualClients: [] as GatewayClientInstance[],
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  GatewayClient: vi.fn(function MockGatewayClient(params: GatewayClientOptions) {
    gatewayMocks.clientOptions = params;
    if (gatewayMocks.constructorError) {
      throw gatewayMocks.constructorError;
    }
    if (gatewayMocks.actualGatewayClient) {
      const client = new gatewayMocks.actualGatewayClient(params);
      gatewayMocks.actualClients.push(client);
      return client;
    }
    if (gatewayMocks.autoHello) {
      queueMicrotask(() => params.onHelloOk?.({} as never));
    }
    return {
      request: gatewayMocks.request,
      stopAndWait: gatewayMocks.stopAndWait,
    };
  }),
  startGatewayClientWhenEventLoopReady: gatewayMocks.startGatewayClientWhenEventLoopReady,
}));

describe("Google Meet voice-call gateway", () => {
  beforeEach(() => {
    vi.useRealTimers();
    gatewayMocks.request.mockReset();
    gatewayMocks.request.mockResolvedValue({ success: true });
    gatewayMocks.runtimeRequest.mockReset();
    gatewayMocks.runtimeRequest.mockResolvedValue({ callId: "call-1" });
    gatewayMocks.stopAndWait.mockReset();
    gatewayMocks.stopAndWait.mockResolvedValue(undefined);
    gatewayMocks.startGatewayClientWhenEventLoopReady.mockReset();
    gatewayMocks.startGatewayClientWhenEventLoopReady.mockResolvedValue({
      ready: true,
      aborted: false,
    });
    gatewayMocks.autoHello = true;
    gatewayMocks.clientOptions = undefined;
    gatewayMocks.constructorError = undefined;
    gatewayMocks.actualGatewayClient = undefined;
    gatewayMocks.actualClients.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/gateway-runtime");
    vi.resetModules();
  });

  it("stops the real gateway client's referenced reconnect after a localhost connection fails", async () => {
    const actual = await vi.importActual<GatewayRuntime>("openclaw/plugin-sdk/gateway-runtime");
    gatewayMocks.actualGatewayClient = actual.GatewayClient;
    gatewayMocks.startGatewayClientWhenEventLoopReady.mockImplementation((client, options) =>
      actual.startGatewayClientWhenEventLoopReady(
        client as Parameters<GatewayRuntime["startGatewayClientWhenEventLoopReady"]>[0],
        options,
      ),
    );

    const server = createServer();
    let connectionCount = 0;
    let resolveReconnect: ((observed: boolean) => void) | undefined;
    const reconnected = new Promise<boolean>((resolve) => {
      resolveReconnect = resolve;
    });
    server.on("upgrade", (_request, socket) => {
      connectionCount += 1;
      socket.destroy();
      if (connectionCount > 1) {
        resolveReconnect?.(true);
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("localhost gateway server did not receive a TCP port");
    }

    const stopAndWait = vi.spyOn(actual.GatewayClient.prototype, "stopAndWait");
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    const clearTimeoutSpy = vi.spyOn(globalThis, "clearTimeout");
    let observationTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = resolveGoogleMeetConfig({
        voiceCall: {
          gatewayUrl: `ws://127.0.0.1:${address.port}`,
          requestTimeoutMs: 3_000,
        },
      });
      const gateway = createVoiceCallGateway({
        config,
        runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
      });

      await expect(
        getMeetVoiceCallGatewayCall({ gateway, callId: "call-1" }),
      ).rejects.toMatchObject({ code: "ECONNRESET", message: "socket hang up" });
      expect(connectionCount).toBe(1);
      expect(gatewayMocks.actualClients).toHaveLength(1);

      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      const referencedRetry = setTimeoutSpy.mock.calls.some(([, delay], index) => {
        const timer = setTimeoutSpy.mock.results[index]?.value as NodeJS.Timeout | undefined;
        return (
          delay === 1_000 &&
          timer?.hasRef() === true &&
          !clearTimeoutSpy.mock.calls.some(([cleared]) => cleared === timer)
        );
      });

      const retryObserved = await Promise.race([
        reconnected,
        new Promise<boolean>((resolve) => {
          observationTimer = setTimeout(() => resolve(false), 1_150);
        }),
      ]);
      if (observationTimer) {
        clearTimeout(observationTimer);
        observationTimer = undefined;
      }

      expect({
        stopCalls: stopAndWait.mock.calls.length,
        reconnected: retryObserved,
        connectionCount,
        referencedRetry,
      }).toEqual({
        stopCalls: 1,
        reconnected: false,
        connectionCount: 1,
        referencedRetry: false,
      });
      expect(gatewayMocks.runtimeRequest).not.toHaveBeenCalled();
    } finally {
      if (observationTimer) {
        clearTimeout(observationTimer);
      }
      await Promise.all(gatewayMocks.actualClients.map((client) => client.stopAndWait()));
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
      stopAndWait.mockRestore();
    }
  });

  it("preserves the original startup failure when failed-client teardown also rejects", async () => {
    gatewayMocks.autoHello = false;
    gatewayMocks.stopAndWait.mockRejectedValueOnce(new Error("gateway teardown failed"));
    const originalError = new Error("external voice gateway refused the connection");
    const config = resolveGoogleMeetConfig({
      voiceCall: { gatewayUrl: "wss://voice.example.test" },
    });
    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });

    const request = getMeetVoiceCallGatewayCall({ gateway, callId: "call-1" });
    gatewayMocks.clientOptions?.onConnectError?.(originalError);

    await expect(request).rejects.toBe(originalError);
    expect(gatewayMocks.stopAndWait).toHaveBeenCalledOnce();
    expect(
      gatewayMocks.startGatewayClientWhenEventLoopReady.mock.calls[0]?.[1]?.signal?.aborted,
    ).toBe(true);
    expect(gatewayMocks.request).not.toHaveBeenCalled();
  });

  it("stops a gateway client when its event-loop readiness fails", async () => {
    gatewayMocks.autoHello = false;
    gatewayMocks.startGatewayClientWhenEventLoopReady.mockResolvedValueOnce({
      ready: false,
      aborted: false,
    });
    const config = resolveGoogleMeetConfig({
      voiceCall: { gatewayUrl: "wss://voice.example.test" },
    });
    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });

    await expect(getMeetVoiceCallGatewayCall({ gateway, callId: "call-1" })).rejects.toThrow(
      "gateway event loop readiness timeout",
    );

    expect(gatewayMocks.stopAndWait).toHaveBeenCalledOnce();
    expect(
      gatewayMocks.startGatewayClientWhenEventLoopReady.mock.calls[0]?.[1]?.signal?.aborted,
    ).toBe(true);
  });

  it("stops a gateway client when the connection deadline expires", async () => {
    vi.useFakeTimers();
    gatewayMocks.autoHello = false;
    const config = resolveGoogleMeetConfig({
      voiceCall: { gatewayUrl: "wss://voice.example.test", requestTimeoutMs: 25 },
    });
    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });

    const rejected = expect(
      getMeetVoiceCallGatewayCall({ gateway, callId: "call-1" }),
    ).rejects.toThrow("gateway connect timeout");
    await vi.advanceTimersByTimeAsync(25);
    await rejected;

    expect(gatewayMocks.stopAndWait).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the startup deadline when constructing the gateway client fails", async () => {
    vi.useFakeTimers();
    const constructorError = new Error("gateway client constructor failed");
    gatewayMocks.constructorError = constructorError;
    const config = resolveGoogleMeetConfig({
      voiceCall: { gatewayUrl: "wss://voice.example.test", requestTimeoutMs: 25 },
    });
    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });

    await expect(getMeetVoiceCallGatewayCall({ gateway, callId: "call-1" })).rejects.toBe(
      constructorError,
    );

    expect(gatewayMocks.stopAndWait).not.toHaveBeenCalled();
    expect(gatewayMocks.startGatewayClientWhenEventLoopReady).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts Twilio Meet calls with pre-connect DTMF, then speaks the intro without TwiML fallback", async () => {
    const config = resolveGoogleMeetConfig({
      voiceCall: {
        gatewayUrl: "ws://127.0.0.1:18789",
        dtmfDelayMs: 1,
        postDtmfSpeechDelayMs: 2,
      },
      realtime: { introMessage: "Say exactly: I'm here and listening." },
    });

    gatewayMocks.request
      .mockResolvedValueOnce({ callId: "call-1" })
      .mockResolvedValueOnce({ success: true });
    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });
    const join = joinMeetViaVoiceCallGateway({
      config,
      gateway,
      dialInNumber: "+15551234567",
      dtmfSequence: "123456#",
      message: "Say exactly: I'm here and listening.",
      requesterSessionKey: "agent:main:discord:channel:general",
      sessionKey: "voice:google-meet:meet-1",
    });

    await join;

    expect(gatewayMocks.request).toHaveBeenNthCalledWith(
      1,
      "voicecall.start",
      {
        to: "+15551234567",
        mode: "conversation",
        dtmfSequence: "123456#",
        requesterSessionKey: "agent:main:discord:channel:general",
        sessionKey: "voice:google-meet:meet-1",
      },
      { timeoutMs: 30_000 },
    );
    expect(gatewayMocks.request).toHaveBeenNthCalledWith(
      2,
      "voicecall.speak",
      {
        callId: "call-1",
        allowTwimlFallback: false,
        message: "Say exactly: I'm here and listening.",
      },
      { timeoutMs: 30_000 },
    );
    expect(gatewayMocks.request).toHaveBeenCalledTimes(2);
    expect(gatewayMocks.runtimeRequest).not.toHaveBeenCalled();
  });

  it("skips the intro without failing when the realtime bridge is not ready", async () => {
    gatewayMocks.request.mockResolvedValueOnce({ callId: "call-1" }).mockResolvedValueOnce({
      success: false,
      error: "No active realtime bridge for call",
    });
    const config = resolveGoogleMeetConfig({
      voiceCall: {
        gatewayUrl: "wss://voice.example.test",
        dtmfDelayMs: 1,
        postDtmfSpeechDelayMs: 1,
      },
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });
    const result = await joinMeetViaVoiceCallGateway({
      config,
      gateway,
      dialInNumber: "+15551234567",
      dtmfSequence: "123456#",
      logger,
      message: "Say exactly: I'm here and listening.",
    });

    expect(result.callId).toBe("call-1");
    expect(result.dtmfSent).toBe(true);
    expect(result.introSent).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      "[google-meet] Skipped intro speech because realtime bridge was not ready: No active realtime bridge for call",
    );
  });

  it("routes the call through the originating agent", async () => {
    const config = resolveGoogleMeetConfig({});
    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });

    await joinMeetViaVoiceCallGateway({
      config,
      gateway,
      dialInNumber: "+15551234567",
      agentId: "support",
      sessionKey: "agent:support:google-meet:meet-1",
    });

    expect(gatewayMocks.runtimeRequest).toHaveBeenCalledWith(
      "voicecall.start",
      expect.objectContaining({
        agentId: "support",
        sessionKey: "agent:support:google-meet:meet-1",
      }),
      { timeoutMs: 30_000 },
    );
  });

  it("rejects per-agent routing through an external Voice Call gateway", async () => {
    const config = resolveGoogleMeetConfig({
      voiceCall: { gatewayUrl: "wss://voice.example.test" },
    });
    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });

    await expect(
      joinMeetViaVoiceCallGateway({
        config,
        gateway,
        dialInNumber: "+15551234567",
        agentId: "support",
      }),
    ).rejects.toThrow("requires the local Gateway runtime");
    expect(gatewayMocks.request).not.toHaveBeenCalled();
  });

  it("treats missing delegated calls as already ended", async () => {
    gatewayMocks.request.mockRejectedValueOnce(new Error("Call not found"));
    const config = resolveGoogleMeetConfig({
      voiceCall: { gatewayUrl: "wss://voice.example.test" },
    });

    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });

    await expect(
      endMeetVoiceCallGatewayCall({ gateway, callId: "call-1" }),
    ).resolves.toBeUndefined();

    expect(gatewayMocks.request).toHaveBeenCalledWith(
      "voicecall.end",
      { callId: "call-1" },
      { timeoutMs: 30_000 },
    );
  });

  it("reads delegated call status from the gateway", async () => {
    gatewayMocks.request.mockResolvedValueOnce({ found: false });
    const config = resolveGoogleMeetConfig({
      voiceCall: { gatewayUrl: "wss://voice.example.test" },
    });

    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });

    await expect(getMeetVoiceCallGatewayCall({ gateway, callId: "call-1" })).resolves.toEqual({
      found: false,
    });

    expect(gatewayMocks.request).toHaveBeenCalledWith(
      "voicecall.status",
      { callId: "call-1" },
      { timeoutMs: 30_000 },
    );
  });

  it("preserves a successful mutating RPC result when client teardown fails", async () => {
    gatewayMocks.request.mockResolvedValueOnce({ callId: "call-1" });
    gatewayMocks.stopAndWait.mockRejectedValueOnce(new Error("gateway teardown failed"));
    const config = resolveGoogleMeetConfig({
      voiceCall: { gatewayUrl: "wss://voice.example.test" },
    });
    const gateway = createVoiceCallGateway({
      config,
      runtime: { gateway: { request: gatewayMocks.runtimeRequest } } as never,
    });

    await expect(
      joinMeetViaVoiceCallGateway({
        config,
        gateway,
        dialInNumber: "+15551234567",
      }),
    ).resolves.toMatchObject({ callId: "call-1" });
    expect(gatewayMocks.stopAndWait).toHaveBeenCalledOnce();
  });
});

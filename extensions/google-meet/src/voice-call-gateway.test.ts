// Google Meet tests cover voice call gateway plugin behavior.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import {
  createVoiceCallGateway,
  endMeetVoiceCallGatewayCall,
  getMeetVoiceCallGatewayCall,
  joinMeetViaVoiceCallGateway,
} from "./voice-call-gateway.js";

const gatewayMocks = vi.hoisted(() => ({
  runtimeRequest: vi.fn(),
  request: vi.fn(),
  stopAndWait: vi.fn(async () => {}),
  startGatewayClientWhenEventLoopReady: vi.fn(async () => ({ ready: true, aborted: false })),
}));

vi.mock("openclaw/plugin-sdk/gateway-runtime", () => ({
  GatewayClient: vi.fn(function MockGatewayClient(params: { onHelloOk?: () => void }) {
    queueMicrotask(() => params.onHelloOk?.());
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
    gatewayMocks.stopAndWait.mockClear();
    gatewayMocks.startGatewayClientWhenEventLoopReady.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/gateway-runtime");
    vi.resetModules();
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

import { describe, expect, it, vi, beforeEach } from "vitest";
import { resolveGoogleMeetConfig } from "./config.js";
import { joinMeetViaVoiceCallGateway } from "./voice-call-gateway.js";

const gatewayMocks = vi.hoisted(() => ({
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
    gatewayMocks.request.mockResolvedValue({ callId: "call-1" });
    gatewayMocks.stopAndWait.mockClear();
    gatewayMocks.startGatewayClientWhenEventLoopReady.mockClear();
  });

  it("starts Twilio Meet calls, sends delayed DTMF, then speaks the intro without TwiML fallback", async () => {
    const config = resolveGoogleMeetConfig({
      voiceCall: {
        gatewayUrl: "ws://127.0.0.1:18789",
        dtmfDelayMs: 1,
        postDtmfSpeechDelayMs: 2,
      },
      realtime: { introMessage: "Say exactly: I'm here and listening." },
    });

    const join = joinMeetViaVoiceCallGateway({
      config,
      dialInNumber: "+15551234567",
      dtmfSequence: "123456#",
      message: "Say exactly: I'm here and listening.",
    });

    await join;

    expect(gatewayMocks.request).toHaveBeenNthCalledWith(
      1,
      "voicecall.start",
      {
        to: "+15551234567",
        mode: "conversation",
      },
      { timeoutMs: 30_000 },
    );
    expect(gatewayMocks.request).toHaveBeenNthCalledWith(
      2,
      "voicecall.dtmf",
      {
        callId: "call-1",
        digits: "123456#",
      },
      { timeoutMs: 30_000 },
    );
    expect(gatewayMocks.request).toHaveBeenNthCalledWith(
      3,
      "voicecall.speak",
      {
        callId: "call-1",
        allowTwimlFallback: false,
        message: "Say exactly: I'm here and listening.",
      },
      { timeoutMs: 30_000 },
    );
    expect(gatewayMocks.request).toHaveBeenCalledTimes(3);
  });

  it("skips the intro without failing when the realtime bridge is not ready", async () => {
    gatewayMocks.request
      .mockResolvedValueOnce({ callId: "call-1" })
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({ success: false, error: "No active realtime bridge for call" });
    const config = resolveGoogleMeetConfig({
      voiceCall: {
        gatewayUrl: "ws://127.0.0.1:18789",
        dtmfDelayMs: 1,
        postDtmfSpeechDelayMs: 1,
      },
    });
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };

    const result = await joinMeetViaVoiceCallGateway({
      config,
      dialInNumber: "+15551234567",
      dtmfSequence: "123456#",
      logger,
      message: "Say exactly: I'm here and listening.",
    });

    expect(result).toMatchObject({ callId: "call-1", dtmfSent: true, introSent: false });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipped intro speech because realtime bridge was not ready"),
    );
  });
});

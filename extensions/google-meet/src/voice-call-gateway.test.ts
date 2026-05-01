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
    gatewayMocks.request.mockReset();
    gatewayMocks.request.mockResolvedValue({ callId: "call-1" });
    gatewayMocks.stopAndWait.mockClear();
    gatewayMocks.startGatewayClientWhenEventLoopReady.mockClear();
  });

  it("starts Twilio Meet calls with pre-connect DTMF and intro metadata", async () => {
    const config = resolveGoogleMeetConfig({
      voiceCall: {
        gatewayUrl: "ws://127.0.0.1:18789",
        dtmfDelayMs: 1,
      },
      realtime: { introMessage: "Say exactly: I'm here and listening." },
    });

    await joinMeetViaVoiceCallGateway({
      config,
      dialInNumber: "+15551234567",
      dtmfSequence: "123456#",
      message: "Say exactly: I'm here and listening.",
    });

    expect(gatewayMocks.request).toHaveBeenNthCalledWith(
      1,
      "voicecall.start",
      {
        to: "+15551234567",
        mode: "conversation",
        message: "Say exactly: I'm here and listening.",
        dtmfSequence: "123456#",
      },
      { timeoutMs: 30_000 },
    );
    expect(gatewayMocks.request).toHaveBeenCalledTimes(1);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  addTranscriptEntryMock,
  clearMaxDurationTimerMock,
  generateNotifyTwimlMock,
  getCallByProviderCallIdMock,
  mapVoiceToPollyMock,
  persistCallRecordMock,
  rejectTranscriptWaiterMock,
  transitionStateMock,
} = vi.hoisted(() => ({
  addTranscriptEntryMock: vi.fn(),
  clearMaxDurationTimerMock: vi.fn(),
  generateNotifyTwimlMock: vi.fn(),
  getCallByProviderCallIdMock: vi.fn(),
  mapVoiceToPollyMock: vi.fn(),
  persistCallRecordMock: vi.fn(),
  rejectTranscriptWaiterMock: vi.fn(),
  transitionStateMock: vi.fn(),
}));

vi.mock("./state.js", () => ({
  addTranscriptEntry: addTranscriptEntryMock,
  transitionState: transitionStateMock,
}));

vi.mock("./store.js", () => ({
  persistCallRecord: persistCallRecordMock,
}));

vi.mock("./timers.js", () => ({
  clearMaxDurationTimer: clearMaxDurationTimerMock,
  clearTranscriptWaiter: vi.fn(),
  rejectTranscriptWaiter: rejectTranscriptWaiterMock,
  waitForFinalTranscript: vi.fn(),
}));

vi.mock("./lookup.js", () => ({
  getCallByProviderCallId: getCallByProviderCallIdMock,
}));

vi.mock("../voice-mapping.js", () => ({
  mapVoiceToPolly: mapVoiceToPollyMock,
}));

vi.mock("./twiml.js", () => ({
  generateNotifyTwiml: generateNotifyTwimlMock,
}));

import { endCall, initiateCall, speak } from "./outbound.js";

function createActiveCallContext(params: { hangupCall?: ReturnType<typeof vi.fn> } = {}) {
  const call = { callId: "call-1", providerCallId: "provider-1", state: "active" };
  const hangupCall = params.hangupCall ?? vi.fn(async () => {});
  const ctx = {
    activeCalls: new Map([["call-1", call]]),
    providerCallIdMap: new Map([["provider-1", "call-1"]]),
    provider: { hangupCall },
    storePath: "/tmp/voice-call.json",
    transcriptWaiters: new Map(),
    maxDurationTimers: new Map(),
  };

  return { call, ctx, hangupCall };
}

describe("voice-call outbound helpers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mapVoiceToPollyMock.mockReturnValue("Polly.Joanna");
    generateNotifyTwimlMock.mockReturnValue("<Response />");
  });

  it("guards initiateCall when provider, webhook, capacity, or fromNumber are missing", async () => {
    const base = {
      activeCalls: new Map(),
      providerCallIdMap: new Map(),
      config: {
        maxConcurrentCalls: 1,
        outbound: { defaultMode: "conversation", notifyHangupDelaySec: 0 },
      },
      storePath: "/tmp/voice-call.json",
      webhookUrl: "https://example.com/webhook",
    };

    await expect(
      initiateCall({ ...base, provider: undefined } as never, "+14155550123"),
    ).resolves.toEqual({
      callId: "",
      success: false,
      error: "Provider not initialized",
    });

    await expect(
      initiateCall(
        { ...base, provider: { name: "twilio" }, webhookUrl: undefined } as never,
        "+14155550123",
      ),
    ).resolves.toEqual({
      callId: "",
      success: false,
      error: "Webhook URL not configured",
    });

    const saturated = {
      ...base,
      activeCalls: new Map([["existing", {}]]),
      provider: { name: "twilio" },
    };
    await expect(initiateCall(saturated as never, "+14155550123")).resolves.toEqual({
      callId: "",
      success: false,
      error: "Maximum concurrent calls (1) reached",
    });

    await expect(
      initiateCall(
        {
          ...base,
          provider: { name: "twilio" },
          config: { ...base.config, fromNumber: "" },
        } as never,
        "+14155550123",
      ),
    ).resolves.toEqual({
      callId: "",
      success: false,
      error: "fromNumber not configured",
    });
  });

  it("initiates notify-mode calls with inline TwiML and records provider ids", async () => {
    const initiateProviderCall = vi.fn(async () => ({ providerCallId: "provider-1" }));
    const ctx = {
      activeCalls: new Map(),
      providerCallIdMap: new Map(),
      provider: { name: "twilio", initiateCall: initiateProviderCall },
      config: {
        maxConcurrentCalls: 3,
        outbound: { defaultMode: "conversation" },
        fromNumber: "+14155550100",
        tts: { provider: "openai", providers: { openai: { voice: "nova" } } },
      },
      storePath: "/tmp/voice-call.json",
      webhookUrl: "https://example.com/webhook",
    };

    const result = await initiateCall(ctx as never, "+14155550123", "session-1", {
      mode: "notify",
      message: "hello there",
    });
    expect(result).toEqual({
      callId: expect.any(String),
      success: true,
    });
    const callId = result.callId;

    expect(mapVoiceToPollyMock).toHaveBeenCalledWith("nova");
    expect(generateNotifyTwimlMock).toHaveBeenCalledWith("hello there", "Polly.Joanna");
    expect(initiateProviderCall).toHaveBeenCalledWith({
      callId,
      from: "+14155550100",
      to: "+14155550123",
      webhookUrl: "https://example.com/webhook",
      inlineTwiml: "<Response />",
    });
    expect(ctx.providerCallIdMap.get("provider-1")).toBe(callId);
    expect(persistCallRecordMock).toHaveBeenCalledTimes(2);
  });

  it("fails initiateCall cleanly when provider initiation throws", async () => {
    const ctx = {
      activeCalls: new Map(),
      providerCallIdMap: new Map(),
      provider: {
        name: "mock",
        initiateCall: vi.fn(async () => {
          throw new Error("provider down");
        }),
      },
      config: {
        maxConcurrentCalls: 3,
        outbound: { defaultMode: "conversation" },
      },
      storePath: "/tmp/voice-call.json",
      webhookUrl: "https://example.com/webhook",
    };

    await expect(initiateCall(ctx as never, "+14155550123")).resolves.toEqual({
      callId: expect.any(String),
      success: false,
      error: "provider down",
    });
    expect(ctx.activeCalls.size).toBe(0);
  });

  it("speaks through connected calls and rolls back to listening on provider errors", async () => {
    const call = { callId: "call-1", providerCallId: "provider-1", state: "active" };
    const playTts = vi.fn(async () => {});
    const ctx = {
      activeCalls: new Map([["call-1", call]]),
      providerCallIdMap: new Map(),
      provider: { name: "twilio", playTts },
      config: { tts: { provider: "openai", providers: { openai: { voice: "alloy" } } } },
      storePath: "/tmp/voice-call.json",
    };

    await expect(speak(ctx as never, "call-1", "hello")).resolves.toEqual({ success: true });
    expect(transitionStateMock).toHaveBeenCalledWith(call, "speaking");
    expect(playTts).toHaveBeenCalledWith({
      callId: "call-1",
      providerCallId: "provider-1",
      text: "hello",
      voice: "alloy",
    });
    expect(addTranscriptEntryMock).toHaveBeenCalledWith(call, "bot", "hello");

    playTts.mockImplementationOnce(async () => {
      throw new Error("tts failed");
    });
    await expect(speak(ctx as never, "call-1", "hello again")).resolves.toEqual({
      success: false,
      error: "tts failed",
    });
    expect(transitionStateMock).toHaveBeenLastCalledWith(call, "listening");
  });

  it("ends connected calls, clears timers, and rejects pending transcripts", async () => {
    const { call, ctx, hangupCall } = createActiveCallContext();

    await expect(endCall(ctx as never, "call-1")).resolves.toEqual({ success: true });
    expect(hangupCall).toHaveBeenCalledWith({
      callId: "call-1",
      providerCallId: "provider-1",
      reason: "hangup-bot",
    });
    expect(call).toEqual(
      expect.objectContaining({
        endReason: "hangup-bot",
        endedAt: expect.any(Number),
      }),
    );
    expect(transitionStateMock).toHaveBeenCalledWith(call, "hangup-bot");
    expect(clearMaxDurationTimerMock).toHaveBeenCalledWith(
      { maxDurationTimers: ctx.maxDurationTimers },
      "call-1",
    );
    expect(rejectTranscriptWaiterMock).toHaveBeenCalledWith(
      { transcriptWaiters: ctx.transcriptWaiters },
      "call-1",
      "Call ended: hangup-bot",
    );
    expect(ctx.activeCalls.size).toBe(0);
    expect(ctx.providerCallIdMap.size).toBe(0);
  });

  it("preserves timeout reasons when ending timed out calls", async () => {
    const { call, ctx, hangupCall } = createActiveCallContext();

    await expect(endCall(ctx as never, "call-1", { reason: "timeout" })).resolves.toEqual({
      success: true,
    });
    expect(hangupCall).toHaveBeenCalledWith({
      callId: "call-1",
      providerCallId: "provider-1",
      reason: "timeout",
    });
    expect(call).toEqual(
      expect.objectContaining({
        endReason: "timeout",
        endedAt: expect.any(Number),
      }),
    );
    expect(transitionStateMock).toHaveBeenCalledWith(call, "timeout");
    expect(rejectTranscriptWaiterMock).toHaveBeenCalledWith(
      { transcriptWaiters: ctx.transcriptWaiters },
      "call-1",
      "Call ended: timeout",
    );
  });

  it("handles missing, disconnected, and already-ended calls", async () => {
    await expect(
      speak(
        {
          activeCalls: new Map(),
          providerCallIdMap: new Map(),
          provider: { name: "twilio", playTts: vi.fn() },
          config: {},
          storePath: "/tmp/voice-call.json",
        } as never,
        "missing",
        "hello",
      ),
    ).resolves.toEqual({ success: false, error: "Call not found" });

    await expect(
      endCall(
        {
          activeCalls: new Map([
            ["call-1", { callId: "call-1", state: "completed", providerCallId: "provider-1" }],
          ]),
          providerCallIdMap: new Map(),
          provider: { hangupCall: vi.fn() },
          storePath: "/tmp/voice-call.json",
          transcriptWaiters: new Map(),
          maxDurationTimers: new Map(),
        } as never,
        "call-1",
      ),
    ).resolves.toEqual({ success: true });
  });
});

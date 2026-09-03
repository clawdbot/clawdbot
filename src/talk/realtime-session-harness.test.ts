// Realtime session harness tests cover shared Talk, echo, talkback, and barge-in behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type { RealtimeVoiceBridge } from "./provider-types.js";
import { createRealtimeVoiceSessionHarness } from "./realtime-session-harness.js";

afterEach(() => {
  vi.useRealTimers();
});

function createHarness(
  overrides: Partial<Parameters<typeof createRealtimeVoiceSessionHarness>[0]> = {},
) {
  return createRealtimeVoiceSessionHarness({
    talk: {
      sessionId: "test-session",
      mode: "realtime",
      transport: "gateway-relay",
      brain: "agent-consult",
      provider: "test",
    },
    talkPayloads: {
      turnStarted: () => ({ surface: "test" }),
      turnEnded: (reason) => ({ reason }),
      inputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioStarted: () => ({ surface: "test" }),
      outputAudioDelta: (audio) => ({ byteLength: audio.byteLength }),
      outputAudioDone: (reason) => ({ reason }),
    },
    ...overrides,
  });
}

function makeBridge(overrides: Partial<RealtimeVoiceBridge> = {}): RealtimeVoiceBridge {
  return {
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(async () => {}),
    isConnected: vi.fn(() => true),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
    ...overrides,
  };
}

describe("realtime voice session harness", () => {
  it.each(["completed", "cancelled", "failed", "incomplete"] as const)(
    "settles one output span and turn for %s responses",
    (status) => {
      const harness = createHarness();
      harness.recordOutputAudio(Buffer.from([1, 2]));
      const outcome =
        status === "failed" || status === "incomplete"
          ? ({ status, responseId: `resp-${status}`, message: `${status} message` } as const)
          : ({ status, responseId: `resp-${status}` } as const);

      expect(harness.finishResponse(outcome).ok).toBe(true);
      expect(harness.finishResponse(outcome)).toEqual({ ok: false, reason: "no_active_turn" });
      expect(harness.talk.recentEvents.map((event) => event.type)).toEqual(
        status === "failed" || status === "incomplete"
          ? [
              "turn.started",
              "output.audio.started",
              "output.audio.delta",
              "output.audio.done",
              "session.error",
              "turn.ended",
            ]
          : [
              "turn.started",
              "output.audio.started",
              "output.audio.delta",
              "output.audio.done",
              status === "cancelled" ? "turn.cancelled" : "turn.ended",
            ],
      );
    },
  );

  it("uses a legacy terminal event only when no typed outcome settled that response", () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const onResponseDone = vi.fn();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return makeBridge();
      },
    };
    const harness = createHarness();
    harness.createBridge({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
      onResponseDone,
    });
    callbacks?.onEvent?.({ direction: "server", type: "response.created", responseId: "resp-1" });
    callbacks?.onResponseDone?.({ status: "completed", responseId: "resp-1" });
    callbacks?.onEvent?.({ direction: "server", type: "response.done", responseId: "resp-1" });

    expect(onResponseDone).toHaveBeenCalledOnce();
    expect(harness.talk.recentEvents.filter((event) => event.type === "turn.ended")).toHaveLength(
      1,
    );

    callbacks?.onEvent?.({ direction: "server", type: "response.created", responseId: "resp-2" });
    callbacks?.onEvent?.({ direction: "server", type: "response.cancelled", responseId: "resp-2" });
    expect(onResponseDone).toHaveBeenLastCalledWith({
      status: "cancelled",
      responseId: "resp-2",
    });
  });

  it("does not let a delayed duplicate terminal event settle a newer turn", () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return makeBridge();
      },
    };
    const harness = createHarness();
    harness.createBridge({ provider, providerConfig: {}, audioSink: { sendAudio: vi.fn() } });
    callbacks?.onEvent?.({ direction: "server", type: "response.created", responseId: "resp-old" });
    callbacks?.onResponseDone?.({ status: "completed", responseId: "resp-old" });
    callbacks?.onEvent?.({ direction: "server", type: "response.created", responseId: "resp-new" });
    callbacks?.onEvent?.({ direction: "server", type: "response.done", responseId: "resp-old" });

    expect(harness.talk.activeTurnId).toBeDefined();
    expect(harness.talk.recentEvents.filter((event) => event.type === "turn.ended")).toHaveLength(
      1,
    );
  });
  it("keeps shared Talk events ordered across input, output, and turn completion", () => {
    const harness = createHarness();

    expect(harness.recordInputAudio(Buffer.from([1, 2]))).toBe(true);
    harness.recordOutputAudio(Buffer.from([3, 4, 5]));
    harness.finishOutputAudio("response.done");
    harness.endTurn("response.done");

    expect(harness.talk.recentEvents.map((event) => event.type)).toEqual([
      "turn.started",
      "input.audio.delta",
      "output.audio.started",
      "output.audio.delta",
      "output.audio.done",
      "turn.ended",
    ]);
    expect(harness.talk.recentEvents.map((event) => event.seq)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("honors a caller-specific recent Talk event limit", () => {
    const harness = createHarness({
      talk: {
        sessionId: "limited-session",
        mode: "realtime",
        transport: "gateway-relay",
        brain: "agent-consult",
        provider: "test",
        maxRecentEvents: 2,
      },
    });

    harness.emit({ type: "session.started", payload: {} });
    harness.emit({ type: "session.ready", payload: {} });
    harness.emit({ type: "session.closed", payload: {}, final: true });

    expect(harness.talk.recentEvents.map((event) => event.type)).toEqual([
      "session.ready",
      "session.closed",
    ]);
  });

  it("suppresses input through queued output playback plus the echo tail", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const harness = createHarness({
      echoSuppression: {
        bytesPerMs: 48,
        tailMs: 3_000,
        transcriptLookbackMs: 45_000,
      },
    });

    harness.recordOutputAudio(Buffer.alloc(48_000));
    vi.setSystemTime(1_100);
    harness.recordOutputAudio(Buffer.alloc(48_000));
    vi.setSystemTime(5_999);
    expect(harness.recordInputAudio(Buffer.from([1, 2, 3, 4]))).toBe(false);
    vi.setSystemTime(6_000);
    expect(harness.recordInputAudio(Buffer.from([5, 6, 7]))).toBe(true);

    expect(harness.getHealth({ providerConnected: true, realtimeReady: true })).toMatchObject({
      lastInputBytes: 3,
      lastOutputBytes: 96_000,
      suppressedInputBytes: 4,
    });
  });

  it("delegates debounced talkback fragments through one consult", async () => {
    vi.useFakeTimers();
    const consult = vi.fn(async ({ question }: { question: string }) => ({
      text: `answer:${question}`,
    }));
    const deliver = vi.fn();
    const harness = createHarness({
      talkback: {
        debounceMs: 100,
        logger: { info: vi.fn(), warn: vi.fn() },
        logPrefix: "[test]",
        responseStyle: "brief",
        fallbackText: "fallback",
        consult,
        deliver,
      },
    });

    harness.talkback?.enqueue("first");
    harness.talkback?.enqueue("second");
    await vi.advanceTimersByTimeAsync(100);

    expect(consult).toHaveBeenCalledOnce();
    expect(consult.mock.calls[0]?.[0]).toMatchObject({
      question: "first\nsecond",
      responseStyle: "brief",
    });
    expect(deliver).toHaveBeenCalledWith("answer:first\nsecond");
  });

  it("detects assistant transcript echo without enabling audio suppression", () => {
    const harness = createHarness({ transcriptLookbackMs: 12_000 });

    harness.recordTranscript("assistant", "I found the shopping list");

    expect(harness.isLikelyAssistantEchoTranscript("I found the shopping list")).toBe(true);
    expect(harness.recordInputAudio(Buffer.from([1, 2]))).toBe(true);
  });

  it("flushes transport output when provider barge-in does not clear it", () => {
    const handleBargeIn = vi.fn();
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: () => makeBridge({ handleBargeIn }),
    };
    const harness = createHarness();
    harness.createBridge({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
    });
    const flushOutput = vi.fn();

    harness.handleBargeIn({ audioPlaybackActive: true }, flushOutput);

    expect(handleBargeIn).toHaveBeenCalledWith({ audioPlaybackActive: true });
    expect(flushOutput).toHaveBeenCalledOnce();
  });
});

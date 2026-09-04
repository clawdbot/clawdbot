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

function createEventlessResponseFixture(
  options: { autoGreeting?: boolean; supported?: boolean } = {},
) {
  const harness = createHarness();
  let callbacks!: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0];
  const onResponseDone = vi.fn();
  const dispatch = vi.fn(() => callbacks.onResponseDone?.({ status: "completed" }));
  const session = harness.createBridge({
    provider: {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return makeBridge(
          options.supported === false
            ? {}
            : { sendUserMessage: dispatch, triggerGreeting: dispatch },
        );
      },
    },
    providerConfig: {},
    audioSink: { sendAudio: vi.fn() },
    triggerGreetingOnReady: options.autoGreeting,
    initialGreetingInstructions: "Say hello",
    onResponseDone,
  });
  return { harness, session, callbacks, dispatch, onResponseDone };
}

describe("realtime voice session harness", () => {
  it.each(["text", "greeting", "default-greeting", "ready-greeting"] as const)(
    "settles an eventless provider's zero-audio response to %s",
    (request) => {
      const { harness, session, callbacks, dispatch, onResponseDone } =
        createEventlessResponseFixture({ autoGreeting: request === "ready-greeting" });
      try {
        if (request === "text") {
          session.sendUserMessage("Speak this answer");
        } else if (request === "ready-greeting") {
          callbacks.onReady?.();
        } else {
          session.triggerGreeting(request === "default-greeting" ? undefined : "Say hello");
        }
        expect(dispatch).toHaveBeenCalledOnce();
        expect(onResponseDone).toHaveBeenCalledExactlyOnceWith({ status: "completed" });
        expect(harness.talk.activeTurnId).toBeUndefined();
        expect(
          harness.talk.recentEvents.filter((event) => event.type === "turn.started"),
        ).toHaveLength(1);
        expect(
          harness.talk.recentEvents.filter((event) => event.type === "turn.ended"),
        ).toHaveLength(1);
      } finally {
        session.close();
        harness.close();
      }
    },
  );

  it.each(["unsupported", "blank-text", "local-close", "provider-close"] as const)(
    "does not admit or dispatch %s requests",
    (reason) => {
      const { harness, session, callbacks, dispatch, onResponseDone } =
        createEventlessResponseFixture({ supported: reason !== "unsupported" });
      try {
        if (reason === "local-close") {
          session.close();
        } else if (reason === "provider-close") {
          callbacks.onClose?.("completed");
        }
        session.sendUserMessage(reason === "blank-text" ? "  " : "Late answer");
        if (reason !== "blank-text") {
          session.triggerGreeting("Late greeting");
        }
        expect(dispatch).not.toHaveBeenCalled();
        expect(onResponseDone).not.toHaveBeenCalled();
        expect(harness.talk.activeTurnId).toBeUndefined();
        expect(harness.talk.recentEvents.filter((event) => event.type === "turn.started")).toEqual(
          [],
        );
      } finally {
        session.close();
        harness.close();
      }
    },
  );

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

  it("settles rejected manual speech before a response is created and fences its terminal twin", () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const provider: RealtimeVoiceProviderPlugin = {
      id: "test",
      label: "Test",
      isConfigured: () => true,
      createBridge: (request) => {
        callbacks = request;
        return makeBridge({
          sendUserMessage: () =>
            request.onEvent?.({ direction: "client", type: "response.create" }),
        });
      },
    };
    const harness = createHarness();
    const onResponseDone = vi.fn(() => session.sendUserMessage("Next answer"));
    const session = harness.createBridge({
      provider,
      providerConfig: {},
      audioSink: { sendAudio: vi.fn() },
      onResponseDone,
    });

    session.sendUserMessage("First answer");
    expect(harness.talk.activeTurnId).toBeDefined();
    const failure = { status: "failed", message: "Speech request rejected" } as const;
    callbacks?.onResponseDone?.(failure);
    expect(onResponseDone).toHaveBeenCalledExactlyOnceWith(failure);

    const nextTurnId = harness.talk.activeTurnId;
    expect(nextTurnId).toBeDefined();
    callbacks?.onEvent?.({ direction: "server", type: "response.done" });
    expect(harness.talk.activeTurnId).toBe(nextTurnId);
    expect(onResponseDone).toHaveBeenCalledOnce();

    onResponseDone.mockImplementation(() => {});
    callbacks?.onEvent?.({
      direction: "server",
      type: "response.created",
      responseId: "resp-next",
    });
    callbacks?.onResponseDone?.({ status: "completed", responseId: "resp-next" });
    callbacks?.onEvent?.({ direction: "server", type: "response.done", responseId: "resp-next" });
    expect(onResponseDone).toHaveBeenCalledTimes(2);
    expect(harness.talk.activeTurnId).toBeUndefined();
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

  it.each(["turn.started", "output.audio.started", "output.audio.delta"] as const)(
    "does not restore output or echo suppression after a %s observer flushes it",
    (eventType) => {
      const events: string[] = [];
      const harness = createHarness({
        echoSuppression: { bytesPerMs: 48, tailMs: 3_000, transcriptLookbackMs: 45_000 },
        onTalkEvent(event) {
          events.push(event.type);
          if (event.type === eventType) {
            harness.flushOutput(() => harness.outputActivity.reset());
          }
        },
      });
      harness.recordOutputAudio(Buffer.alloc(48_000));
      expect(events.at(-1)).toBe(eventType);
      expect(harness.outputActivity.snapshot().chunks).toBe(0);
      expect(harness.recordInputAudio(Buffer.alloc(480))).toBe(true);
      harness.close();
    },
  );

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

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

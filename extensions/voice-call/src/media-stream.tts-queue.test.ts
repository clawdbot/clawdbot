import type {
  RealtimeTranscriptionProviderPlugin,
  RealtimeTranscriptionSession,
} from "openclaw/plugin-sdk/realtime-transcription";
import { describe, expect, it } from "vitest";
import { MediaStreamHandler } from "./media-stream.js";
import { withTimeout } from "./websocket-test-support.js";

const createStubSession = (): RealtimeTranscriptionSession => ({
  connect: async () => {},
  sendAudio: () => {},
  close: () => {},
  isConnected: () => true,
});

const createStubSttProvider = (): RealtimeTranscriptionProviderPlugin =>
  ({
    createSession: () => createStubSession(),
    id: "openai",
    label: "OpenAI",
    isConfigured: () => true,
  }) as unknown as RealtimeTranscriptionProviderPlugin;

const createHandler = (): MediaStreamHandler =>
  new MediaStreamHandler({
    transcriptionProvider: createStubSttProvider(),
    providerConfig: {},
  });

const createDeferred = (): {
  promise: Promise<void>;
  resolve: () => void;
} => {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  if (!resolve) {
    throw new Error("Expected deferred callback to be initialized");
  }
  return { promise, resolve };
};

const waitForAbort = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    signal.addEventListener("abort", () => resolve(), { once: true });
  });

describe("MediaStreamHandler TTS queue", () => {
  it("bounds pending playback per stream and recovers after draining", async () => {
    const handler = createHandler();
    const activeGate = createDeferred();
    const playbackOrder: number[] = [];

    const active = handler.queueTts("stream-1", async () => {
      playbackOrder.push(0);
      await activeGate.promise;
    });
    const pending = Array.from({ length: 8 }, (_, index) =>
      handler.queueTts("stream-1", async () => {
        playbackOrder.push(index + 1);
      }),
    );
    let overflowRan = false;

    await expect(
      handler.queueTts("stream-1", async () => {
        overflowRan = true;
      }),
    ).rejects.toThrow("Telephony TTS queue is full for stream; maxPending=8");

    await handler.queueTts("stream-2", async () => {});
    expect(overflowRan).toBe(false);

    activeGate.resolve();
    await active;
    await Promise.all(pending);
    expect(playbackOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);

    await handler.queueTts("stream-1", async () => {
      playbackOrder.push(9);
    });
    expect(playbackOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("serializes TTS playback and resolves in order", async () => {
    const handler = createHandler();
    const started: number[] = [];
    const finished: number[] = [];
    const firstGate = createDeferred();

    const first = handler.queueTts("stream-1", async () => {
      started.push(1);
      await firstGate.promise;
      finished.push(1);
    });
    const second = handler.queueTts("stream-1", async () => {
      started.push(2);
      finished.push(2);
    });

    expect(started).toEqual([1]);

    firstGate.resolve();
    await first;
    await second;

    expect(started).toEqual([1, 2]);
    expect(finished).toEqual([1, 2]);
  });

  it("cancels active playback and clears queued items", async () => {
    const handler = createHandler();
    let queuedRan = false;
    const started: string[] = [];

    const active = handler.queueTts("stream-1", async (signal) => {
      started.push("active");
      await waitForAbort(signal);
    });
    const queued = handler.queueTts("stream-1", async () => {
      queuedRan = true;
    });

    expect(started).toEqual(["active"]);

    handler.clearTtsQueue("stream-1");
    await active;
    await withTimeout(queued);

    expect(queuedRan).toBe(false);
  });

  it("removes all queue state during stream teardown", async () => {
    const handler = createHandler();
    let queuedRan = false;
    const active = handler.queueTts("stream-1", async (signal) => {
      await waitForAbort(signal);
    });
    const queued = handler.queueTts("stream-1", async () => {
      queuedRan = true;
    });

    (
      handler as unknown as {
        clearTtsState(streamSid: string): void;
      }
    ).clearTtsState("stream-1");

    await withTimeout(active);
    await withTimeout(queued);
    expect(queuedRan).toBe(false);

    const state = handler as unknown as {
      ttsQueues: Map<string, unknown[]>;
      ttsPlaying: Map<string, boolean>;
      ttsActiveControllers: Map<string, AbortController>;
    };
    expect(state.ttsQueues.has("stream-1")).toBe(false);
    expect(state.ttsPlaying.has("stream-1")).toBe(false);
    expect(state.ttsActiveControllers.has("stream-1")).toBe(false);
  });
});

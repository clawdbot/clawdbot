import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../talk/provider-types.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import { startMeetingRealtimeEngine } from "./realtime-engine.js";

type PendingWrite = {
  resolve: () => void;
};

async function createEngineFixture() {
  let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
  let onHumanBargeIn: ((audio: Buffer) => boolean) | undefined;
  const handleBargeIn = vi.fn();
  const bridge: RealtimeVoiceBridge = {
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(async () => {}),
    handleBargeIn,
    isConnected: vi.fn(() => true),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult: vi.fn(),
  };
  const provider: RealtimeVoiceProviderPlugin = {
    id: "test",
    label: "Test",
    isConfigured: () => true,
    createBridge: (request) => {
      callbacks = request;
      return bridge;
    },
  };
  const pendingWrites: PendingWrite[] = [];
  const writeOutput = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        pendingWrites.push({ resolve });
      }),
  );
  const clearOutput = vi.fn(async () => {});
  const beginOutput = vi.fn();
  const transport: MeetingRealtimeAudioTransport = {
    beginOutput,
    clearOutput,
    dispose: vi.fn(async () => {}),
    onFatal: vi.fn(),
    startBargeInMonitor: (handler) => {
      onHumanBargeIn = handler;
    },
    startInput: vi.fn(),
    stop: vi.fn(async () => {}),
    writeOutput,
  };
  const handle = await startMeetingRealtimeEngine({
    config: {
      chrome: { audioFormat: "pcm16-24khz" },
      realtime: {
        strategy: "bidi",
        provider: "test",
        providers: { test: {} },
      },
    },
    consultAgent: vi.fn(async () => ({ text: "unused" })),
    fullConfig: {} as never,
    handleToolCall: vi.fn(async () => {}),
    logger: {
      debug: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    },
    meetingSessionId: "meeting-1",
    platform: {
      displayName: "Test Meeting",
      logScope: "[meeting-test]",
      sessionIdPrefix: "meeting-test",
    },
    providers: [provider],
    runtime: {} as never,
    tools: [],
    transport,
  });
  if (!callbacks) {
    throw new Error("Expected realtime voice bridge callbacks");
  }
  return {
    beginOutput,
    callbacks,
    clearOutput,
    handle,
    handleBargeIn,
    releaseWrite(index: number) {
      const pending = pendingWrites[index];
      if (!pending) {
        throw new Error(`Expected pending output write ${index}`);
      }
      pending.resolve();
    },
    triggerHumanBargeIn(audio = Buffer.from([1])) {
      if (!onHumanBargeIn) {
        throw new Error("Expected human barge-in monitor");
      }
      return onHumanBargeIn(audio);
    },
    writeOutput,
  };
}

describe("meeting realtime engine output ownership", () => {
  it("serializes transport writes and coalesces queued 20 ms frames", async () => {
    const fixture = await createEngineFixture();
    try {
      const first = Buffer.alloc(960, 1);
      const queued = Array.from({ length: 30 }, (_, index) => Buffer.alloc(960, index + 2));

      fixture.callbacks.onAudio(first);
      for (const frame of queued) {
        fixture.callbacks.onAudio(frame);
      }
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(first);

      fixture.releaseWrite(0);
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(Buffer.concat(queued.slice(0, 25)));

      fixture.releaseWrite(1);
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(3);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(Buffer.concat(queued.slice(25)));
      fixture.releaseWrite(2);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("does not start an invalidated write after a same-turn clear", async () => {
    const fixture = await createEngineFixture();
    try {
      fixture.callbacks.onAudio(Buffer.from([1, 2, 3]));
      fixture.callbacks.onClearAudio();
      await Promise.resolve();

      expect(fixture.writeOutput).not.toHaveBeenCalled();
      expect(fixture.clearOutput).toHaveBeenCalled();
    } finally {
      await fixture.handle.stop();
    }
  });

  it("invalidates queued output when human barge-in clears playback", async () => {
    const fixture = await createEngineFixture();
    try {
      const active = Buffer.from([1]);
      const stale = Buffer.from([2]);
      const fresh = Buffer.from([3]);

      fixture.callbacks.onAudio(active);
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      });
      fixture.callbacks.onAudio(stale);

      expect(fixture.triggerHumanBargeIn()).toBe(true);
      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
      });
      fixture.callbacks.onEvent?.({ direction: "server", type: "response.cancelled" });
      fixture.callbacks.onAudio(fresh);
      fixture.releaseWrite(0);

      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);
      expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

  it.each(["response.done", "response.cancelled"])(
    "bounds queued bytes and rejects stale output through %s",
    async (terminalType) => {
      const fixture = await createEngineFixture();
      try {
        const first = Buffer.alloc(48_000, 1);
        const queued = Buffer.alloc(48_000, 2);
        const overflow = Buffer.from([3]);
        const late = Buffer.from([4]);
        const fresh = Buffer.from([5]);

        fixture.callbacks.onAudio(first);
        await vi.waitFor(() => {
          expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
        });
        fixture.callbacks.onAudio(queued);
        fixture.callbacks.onAudio(overflow);

        await vi.waitFor(() => {
          expect(fixture.handleBargeIn).toHaveBeenCalledWith({
            audioPlaybackActive: true,
            force: true,
          });
        });
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
        expect(fixture.writeOutput).toHaveBeenLastCalledWith(first);

        fixture.callbacks.onAudio(late);
        fixture.callbacks.onEvent?.({ direction: "server", type: terminalType });
        fixture.callbacks.onAudio(fresh);
        fixture.releaseWrite(0);

        await vi.waitFor(() => {
          expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
        });
        expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
        expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
        expect(fixture.clearOutput.mock.invocationCallOrder[1]).toBeLessThan(
          fixture.writeOutput.mock.invocationCallOrder[1] ?? 0,
        );
        expect(fixture.beginOutput).toHaveBeenCalledTimes(2);
        fixture.releaseWrite(1);
      } finally {
        await fixture.handle.stop();
      }
    },
  );

  it("bounds queued tiny-frame ownership", async () => {
    const fixture = await createEngineFixture();
    try {
      fixture.callbacks.onAudio(Buffer.from([0]));
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      });
      for (let index = 1; index < 257; index += 1) {
        fixture.callbacks.onAudio(Buffer.from([index]));
      }

      await vi.waitFor(() => {
        expect(fixture.handleBargeIn).toHaveBeenCalledWith({
          audioPlaybackActive: true,
          force: true,
        });
      });
      expect(fixture.clearOutput).toHaveBeenCalledOnce();
      fixture.releaseWrite(0);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("does not report a deferred cancellation race after response completion", async () => {
    const fixture = await createEngineFixture();
    try {
      fixture.callbacks.onAudio(Buffer.alloc(48_000, 1));
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      });
      fixture.callbacks.onAudio(Buffer.alloc(48_000, 2));
      fixture.callbacks.onAudio(Buffer.from([3]));
      await vi.waitFor(() => {
        expect(fixture.handleBargeIn).toHaveBeenCalledOnce();
      });

      fixture.callbacks.onEvent?.({ direction: "server", type: "response.done" });
      fixture.callbacks.onEvent?.({
        direction: "server",
        type: "error",
        detail: "Cancellation failed: no active response found",
      });

      expect(fixture.handle.getHealth().recentTalkEvents.map((event) => event.type)).not.toContain(
        "session.error",
      );
      fixture.releaseWrite(0);
    } finally {
      await fixture.handle.stop();
    }
  });
});

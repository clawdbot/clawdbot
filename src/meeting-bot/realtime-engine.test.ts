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
    writeOutput,
  };
}

describe("meeting realtime engine output ownership", () => {
  it("serializes transport writes", async () => {
    const fixture = await createEngineFixture();
    try {
      const first = Buffer.from([1]);
      const second = Buffer.from([2]);
      const third = Buffer.from([3]);

      fixture.callbacks.onAudio(first);
      fixture.callbacks.onAudio(second);
      fixture.callbacks.onAudio(third);
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(first);

      fixture.releaseWrite(0);
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(second);

      fixture.releaseWrite(1);
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(3);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(third);
      fixture.releaseWrite(2);
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
        fixture.callbacks.onAudio(queued);
        fixture.callbacks.onAudio(overflow);

        expect(fixture.handleBargeIn).toHaveBeenCalledWith({
          audioPlaybackActive: true,
          force: true,
        });
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
        await vi.waitFor(() => {
          expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
        });
        expect(fixture.writeOutput).toHaveBeenLastCalledWith(first);

        fixture.callbacks.onAudio(late);
        fixture.callbacks.onEvent?.({ direction: "server", type: terminalType });
        fixture.callbacks.onAudio(fresh);
        fixture.releaseWrite(0);

        await vi.waitFor(() => {
          expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
        });
        expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
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
      for (let index = 0; index < 257; index += 1) {
        fixture.callbacks.onAudio(Buffer.from([index]));
      }

      expect(fixture.handleBargeIn).toHaveBeenCalledWith({
        audioPlaybackActive: true,
        force: true,
      });
      expect(fixture.clearOutput).toHaveBeenCalledOnce();
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      });
      fixture.releaseWrite(0);
    } finally {
      await fixture.handle.stop();
    }
  });
});

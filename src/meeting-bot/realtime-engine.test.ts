import { describe, expect, it, vi } from "vitest";
import type { RealtimeVoiceProviderPlugin } from "../plugins/types.js";
import type {
  RealtimeVoiceBridge,
  RealtimeVoiceBridgeCreateRequest,
} from "../talk/provider-types.js";
import type { MeetingRealtimeAudioTransport } from "./realtime-audio-transport.js";
import {
  startMeetingRealtimeEngine,
  type MeetingRealtimeToolCallParams,
} from "./realtime-engine.js";

type PendingWrite = {
  resolve: () => void;
};

async function createEngineFixture(options?: {
  handleToolCall?: (params: MeetingRealtimeToolCallParams) => Promise<void>;
}) {
  let callbacks: RealtimeVoiceBridgeCreateRequest | undefined;
  let onHumanBargeIn: ((audio: Buffer) => boolean) | undefined;
  const handleBargeIn = vi.fn();
  const submitToolResult = vi.fn();
  const bridge: RealtimeVoiceBridge = {
    acknowledgeMark: vi.fn(),
    close: vi.fn(),
    connect: vi.fn(async () => {}),
    handleBargeIn,
    isConnected: vi.fn(() => true),
    sendAudio: vi.fn(),
    setMediaTimestamp: vi.fn(),
    submitToolResult,
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
    handleToolCall: options?.handleToolCall ?? vi.fn(async () => {}),
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
  const bridgeCallbacks = callbacks;
  return {
    beginOutput,
    callbacks: bridgeCallbacks,
    clearOutput,
    handle,
    handleBargeIn,
    submitToolResult,
    releaseWrite(index: number) {
      const pending = pendingWrites[index];
      if (!pending) {
        throw new Error(`Expected pending output write ${index}`);
      }
      pending.resolve();
    },
    announceOutputResponse(responseId: string) {
      bridgeCallbacks.onEvent?.({
        direction: "server",
        responseId,
        type: "response.created",
      });
    },
    sendOutputAudio(audio: Buffer, responseId?: string) {
      bridgeCallbacks.onEvent?.({
        direction: "server",
        ...(responseId ? { responseId } : {}),
        type: "response.audio.delta",
      });
      bridgeCallbacks.onAudio(audio);
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
  it.each([
    [{ status: "completed" as const, responseId: "response-1" }, "turn.ended"],
    [
      { status: "failed" as const, responseId: "response-1", message: "provider failed" },
      "turn.ended",
    ],
    [
      {
        status: "incomplete" as const,
        responseId: "response-1",
        reason: "max_output_tokens",
        message: "provider response incomplete",
      },
      "turn.ended",
    ],
    [
      { status: "cancelled" as const, responseId: "response-1", reason: "client_cancelled" },
      "turn.cancelled",
    ],
  ])("finishes each response once and accepts a later response", async (outcome, terminalType) => {
    const fixture = await createEngineFixture();
    try {
      fixture.callbacks.onTranscript?.("user", "first turn", true);
      fixture.announceOutputResponse("response-1");
      fixture.sendOutputAudio(Buffer.from([1]), "response-1");
      await vi.waitFor(() => expect(fixture.writeOutput).toHaveBeenCalledTimes(1));
      fixture.callbacks.onResponseDone?.(outcome);
      fixture.callbacks.onEvent?.({
        direction: "server",
        responseId: outcome.responseId,
        type: "response.done",
      });

      const firstEvents = fixture.handle.getHealth().recentTalkEvents;
      expect(firstEvents.filter((event) => event.type === terminalType)).toHaveLength(1);
      expect(firstEvents.filter((event) => event.type === "output.audio.done")).toHaveLength(1);
      expect(firstEvents.filter((event) => event.type === "session.error")).toHaveLength(
        outcome.status === "failed" || outcome.status === "incomplete" ? 1 : 0,
      );
      expect(fixture.handle.getHealth().bridgeClosed).toBe(false);

      fixture.releaseWrite(0);
      fixture.callbacks.onTranscript?.("user", "later turn", true);
      fixture.announceOutputResponse("response-2");
      fixture.sendOutputAudio(Buffer.from([2]), "response-2");
      await vi.waitFor(() => expect(fixture.writeOutput).toHaveBeenCalledTimes(2));
      fixture.callbacks.onResponseDone?.({ status: "completed", responseId: "response-2" });
      fixture.callbacks.onEvent?.({
        direction: "server",
        responseId: "response-2",
        type: "response.done",
      });

      const finalEvents = fixture.handle.getHealth().recentTalkEvents;
      expect(
        finalEvents.filter(
          (event) => event.type === "turn.ended" || event.type === "turn.cancelled",
        ),
      ).toHaveLength(2);
      expect(finalEvents.filter((event) => event.type === "output.audio.done")).toHaveLength(2);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("rearms continuity reset when the provider creates a fresh session before ready", async () => {
    const fixture = await createEngineFixture();
    try {
      fixture.callbacks.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });
      fixture.callbacks.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });
      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
      });

      fixture.callbacks.onEvent?.({
        direction: "server",
        type: "session.created",
      });
      fixture.callbacks.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });
      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
      });
    } finally {
      await fixture.handle.stop();
    }
  });

  it("resets provider continuity without replaying old output or tool work", async () => {
    let releaseTool: (() => void) | undefined;
    const toolGate = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const fixture = await createEngineFixture({
      handleToolCall: async ({ session, event, onTalkEvent }) => {
        await toolGate;
        await session.submitToolResult(event.callId, { text: "stale result" });
        onTalkEvent({
          type: "tool.result",
          callId: event.callId,
          payload: { name: event.name },
          final: true,
        });
      },
    });
    try {
      const active = Buffer.from([1]);
      const stale = Buffer.from([2]);
      const fresh = Buffer.from([3]);
      fixture.callbacks.onReady?.();
      fixture.callbacks.onTranscript?.("user", "old turn", true);
      fixture.sendOutputAudio(active, "response-1");
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledOnce();
      });
      fixture.sendOutputAudio(stale, "response-1");
      fixture.callbacks.onToolCall?.({
        itemId: "item-old",
        callId: "call-old",
        name: "openclaw_agent_consult",
        args: { question: "old work" },
      });

      fixture.callbacks.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });
      fixture.callbacks.onEvent?.({
        direction: "client",
        type: "session.continuity.reset",
      });

      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
      });
      expect(fixture.handleBargeIn).not.toHaveBeenCalled();
      expect(
        fixture.handle
          .getHealth()
          .recentTalkEvents.filter((event) => event.type === "turn.cancelled"),
      ).toHaveLength(1);

      releaseTool?.();
      await Promise.resolve();
      await Promise.resolve();
      expect(fixture.submitToolResult).not.toHaveBeenCalled();
      expect(
        fixture.handle.getHealth().recentTalkEvents.some((event) => event.type === "tool.result"),
      ).toBe(false);

      fixture.releaseWrite(0);
      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
      });
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);

      fixture.callbacks.onReady?.();
      fixture.sendOutputAudio(fresh, "response-1");
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

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

  it("accepts ordered provider output after a clear without a response owner", async () => {
    const fixture = await createEngineFixture();
    try {
      const stale = Buffer.from([1, 2, 3]);
      const fresh = Buffer.from([4, 5, 6]);

      fixture.callbacks.onAudio(stale);
      fixture.callbacks.onClearAudio("barge-in");
      fixture.callbacks.onAudio(fresh);

      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledOnce();
      });
      expect(fixture.writeOutput).toHaveBeenCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);
      expect(fixture.clearOutput).toHaveBeenCalledOnce();
      expect(fixture.beginOutput).toHaveBeenCalledTimes(2);
      fixture.releaseWrite(0);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("invalidates queued output when human barge-in clears playback", async () => {
    const fixture = await createEngineFixture();
    try {
      const active = Buffer.from([1]);
      const stale = Buffer.from([2]);
      const late = Buffer.from([3]);
      const fresh = Buffer.from([4]);

      fixture.announceOutputResponse("response-1");
      fixture.sendOutputAudio(active);
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      });
      fixture.sendOutputAudio(stale);

      expect(fixture.triggerHumanBargeIn()).toBe(true);
      await vi.waitFor(() => {
        expect(fixture.clearOutput).toHaveBeenCalledOnce();
      });
      fixture.sendOutputAudio(late);
      fixture.announceOutputResponse("response-2");
      fixture.sendOutputAudio(fresh);
      fixture.releaseWrite(0);

      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
      expect(fixture.clearOutput).toHaveBeenCalledTimes(2);
      expect(fixture.beginOutput).toHaveBeenCalledTimes(2);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("rejects a cleared response whose first audio arrives after barge-in", async () => {
    const fixture = await createEngineFixture();
    try {
      const stale = Buffer.from([1]);
      const fresh = Buffer.from([2]);

      fixture.announceOutputResponse("response-1");
      fixture.callbacks.onClearAudio("barge-in");
      fixture.callbacks.onAudio(stale);
      fixture.announceOutputResponse("response-2");
      fixture.callbacks.onAudio(fresh);

      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledOnce();
      });
      expect(fixture.writeOutput).toHaveBeenCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(stale);
      fixture.releaseWrite(0);
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

        fixture.sendOutputAudio(first, "response-1");
        await vi.waitFor(() => {
          expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
        });
        fixture.sendOutputAudio(queued, "response-1");
        fixture.sendOutputAudio(overflow, "response-1");

        await vi.waitFor(() => {
          expect(fixture.handleBargeIn).toHaveBeenCalledWith({
            audioPlaybackActive: true,
            force: true,
          });
        });
        fixture.callbacks.onClearAudio("barge-in");
        await vi.waitFor(() => {
          expect(fixture.clearOutput).toHaveBeenCalledOnce();
        });
        expect(fixture.writeOutput).toHaveBeenLastCalledWith(first);

        fixture.sendOutputAudio(late, "response-1");
        fixture.callbacks.onEvent?.({
          direction: "server",
          responseId: "response-1",
          type: terminalType,
        });
        fixture.sendOutputAudio(fresh, "response-2");
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

  it("accepts a new response owner after backpressure without the stale response terminal", async () => {
    const fixture = await createEngineFixture();
    try {
      const active = Buffer.alloc(48_000, 1);
      const queued = Buffer.alloc(48_000, 2);
      const late = Buffer.from([3]);
      const fresh = Buffer.from([4]);

      fixture.sendOutputAudio(active, "response-1");
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledOnce();
      });
      fixture.sendOutputAudio(queued, "response-1");
      fixture.sendOutputAudio(Buffer.from([5]), "response-1");
      await vi.waitFor(() => {
        expect(fixture.handleBargeIn).toHaveBeenCalledWith({
          audioPlaybackActive: true,
          force: true,
        });
      });

      fixture.sendOutputAudio(late, "response-1");
      fixture.sendOutputAudio(fresh, "response-2");
      fixture.releaseWrite(0);

      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("holds anonymous backpressure output until the provider clear fence", async () => {
    const fixture = await createEngineFixture();
    try {
      const active = Buffer.alloc(48_000, 1);
      const queued = Buffer.alloc(48_000, 2);
      const late = Buffer.from([3]);
      const fresh = Buffer.from([4]);

      fixture.callbacks.onAudio(active);
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledOnce();
      });
      fixture.callbacks.onAudio(queued);
      fixture.callbacks.onAudio(Buffer.from([5]));
      await vi.waitFor(() => {
        expect(fixture.handleBargeIn).toHaveBeenCalledOnce();
      });

      fixture.callbacks.onAudio(late);
      fixture.callbacks.onClearAudio("barge-in");
      fixture.callbacks.onAudio(fresh);
      fixture.releaseWrite(0);

      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });

  it("bounds queued tiny-frame ownership", async () => {
    const fixture = await createEngineFixture();
    try {
      fixture.sendOutputAudio(Buffer.from([0]), "response-1");
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      });
      for (let index = 1; index < 257; index += 1) {
        fixture.sendOutputAudio(Buffer.from([index]), "response-1");
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
      const replacement = Buffer.from([4]);
      const late = Buffer.from([5]);
      const fresh = Buffer.from([6]);

      fixture.sendOutputAudio(Buffer.alloc(48_000, 1), "response-1");
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(1);
      });
      fixture.sendOutputAudio(Buffer.alloc(48_000, 2), "response-1");
      fixture.sendOutputAudio(Buffer.from([3]), "response-1");
      await vi.waitFor(() => {
        expect(fixture.handleBargeIn).toHaveBeenCalledOnce();
      });

      fixture.callbacks.onEvent?.({
        direction: "server",
        responseId: "response-1",
        type: "response.done",
      });
      fixture.announceOutputResponse("response-2");
      fixture.sendOutputAudio(replacement);
      fixture.callbacks.onEvent?.({
        direction: "server",
        type: "error",
        detail: "Cancellation failed: no active response found",
      });
      expect(fixture.triggerHumanBargeIn()).toBe(true);
      fixture.sendOutputAudio(late);
      fixture.announceOutputResponse("response-3");
      fixture.sendOutputAudio(fresh);
      fixture.releaseWrite(0);

      expect(fixture.handle.getHealth().recentTalkEvents.map((event) => event.type)).not.toContain(
        "session.error",
      );
      await vi.waitFor(() => {
        expect(fixture.writeOutput).toHaveBeenCalledTimes(2);
      });
      expect(fixture.writeOutput).toHaveBeenLastCalledWith(fresh);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(replacement);
      expect(fixture.writeOutput).not.toHaveBeenCalledWith(late);
      fixture.releaseWrite(1);
    } finally {
      await fixture.handle.stop();
    }
  });
});

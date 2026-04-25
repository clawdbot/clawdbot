import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceClawGeminiLiveAdapter } from "./gemini-live.js";

describe("VoiceClawGeminiLiveAdapter watchdog", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stays paused while async OpenClaw tool work is still running", () => {
    vi.useFakeTimers();
    const adapter = new VoiceClawGeminiLiveAdapter();
    const internals = adapter as unknown as {
      watchdogEnabled: boolean;
      resetWatchdog: () => void;
      sendUpstream: (message: Record<string, unknown>) => void;
    };
    const sendUpstream = vi.fn();
    internals.watchdogEnabled = true;
    internals.sendUpstream = sendUpstream;

    adapter.beginAsyncToolCall("call-1");
    internals.resetWatchdog();
    vi.advanceTimersByTime(21_000);

    expect(sendUpstream).not.toHaveBeenCalled();

    adapter.finishAsyncToolCall("call-1");
    vi.advanceTimersByTime(20_000);

    expect(sendUpstream).toHaveBeenCalledOnce();
    expect(sendUpstream.mock.calls[0][0]).toMatchObject({
      realtimeInput: {
        text: expect.stringContaining("user has been silent"),
      },
    });
  });
});

describe("VoiceClawGeminiLiveAdapter tool cancellation", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("releases the watchdog hold when Gemini cancels an already-acked async tool", () => {
    vi.useFakeTimers();
    const adapter = new VoiceClawGeminiLiveAdapter();
    const events: unknown[] = [];
    const sendUpstream = vi.fn();
    const internals = adapter as unknown as {
      asyncToolCallIds: Set<string>;
      handleServerMessage: (message: Record<string, unknown>) => void;
      sendToClient: (event: unknown) => void;
      sendUpstream: (message: Record<string, unknown>) => void;
      watchdogEnabled: boolean;
    };
    internals.sendToClient = (event) => events.push(event);
    internals.sendUpstream = sendUpstream;
    internals.watchdogEnabled = true;

    adapter.beginAsyncToolCall("call-1");
    internals.handleServerMessage({ toolCallCancellation: { ids: ["call-1"] } });
    vi.advanceTimersByTime(20_000);

    expect(events).toContainEqual({ type: "tool.cancelled", callIds: ["call-1"] });
    expect(internals.asyncToolCallIds.size).toBe(0);
    expect(sendUpstream).toHaveBeenCalledOnce();
  });

  it("cancels async OpenClaw tool work when Gemini closes after the working ack", () => {
    const adapter = new VoiceClawGeminiLiveAdapter();
    const events: unknown[] = [];
    const internals = adapter as unknown as {
      asyncToolCallIds: Set<string>;
      handleUpstreamClose: (code: number) => void;
      sendToClient: (event: unknown) => void;
    };
    internals.sendToClient = (event) => events.push(event);

    adapter.beginAsyncToolCall("call-1");
    internals.handleUpstreamClose(1000);

    expect(events).toContainEqual({ type: "tool.cancelled", callIds: ["call-1"] });
    expect(events).toContainEqual({
      type: "error",
      message: "Gemini Live closed while a tool call was in flight",
      code: 502,
    });
    expect(internals.asyncToolCallIds.size).toBe(0);
  });

  it("defers goAway rotation until async OpenClaw tool work finishes", () => {
    const adapter = new VoiceClawGeminiLiveAdapter();
    const reconnect = vi.fn();
    const internals = adapter as unknown as {
      currentlyResumable: boolean;
      handleServerMessage: (message: Record<string, unknown>) => void;
      reconnect: (reason: string) => void;
      resumptionHandle: string;
      rotateAfterToolCalls: boolean;
    };
    internals.currentlyResumable = true;
    internals.resumptionHandle = "resume-1";
    internals.reconnect = reconnect;

    adapter.beginAsyncToolCall("call-1");
    internals.handleServerMessage({ goAway: {} });

    expect(reconnect).not.toHaveBeenCalled();
    expect(internals.rotateAfterToolCalls).toBe(true);

    adapter.finishAsyncToolCall("call-1");

    expect(internals.rotateAfterToolCalls).toBe(false);
    expect(reconnect).toHaveBeenCalledWith("deferred goAway");
  });

  it("rotates after goAway when Gemini cancels the deferred async tool", () => {
    const adapter = new VoiceClawGeminiLiveAdapter();
    const reconnect = vi.fn();
    const internals = adapter as unknown as {
      currentlyResumable: boolean;
      handleServerMessage: (message: Record<string, unknown>) => void;
      reconnect: (reason: string) => void;
      resumptionHandle: string;
      rotateAfterToolCalls: boolean;
    };
    internals.currentlyResumable = true;
    internals.resumptionHandle = "resume-1";
    internals.reconnect = reconnect;

    adapter.beginAsyncToolCall("call-1");
    internals.handleServerMessage({ goAway: {} });
    internals.handleServerMessage({ toolCallCancellation: { ids: ["call-1"] } });

    expect(internals.rotateAfterToolCalls).toBe(false);
    expect(reconnect).toHaveBeenCalledWith("deferred goAway");
  });
});

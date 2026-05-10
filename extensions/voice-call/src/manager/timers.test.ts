import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { persistCallRecordMock } = vi.hoisted(() => ({
  persistCallRecordMock: vi.fn(),
}));

vi.mock("./store.js", () => ({
  persistCallRecord: persistCallRecordMock,
}));

import {
  clearMaxDurationTimer,
  clearTranscriptWaiter,
  rejectTranscriptWaiter,
  resolveTranscriptWaiter,
  startMaxDurationTimer,
  waitForFinalTranscript,
} from "./timers.js";

describe("voice-call manager timers", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("starts and clears max duration timers, persisting timeout metadata before delegation", async () => {
    const call = { id: "call-1", state: "active" };
    const ctx = {
      activeCalls: new Map([["call-1", call]]),
      maxDurationTimers: new Map(),
      config: { maxDurationSeconds: 5 },
      storePath: "/tmp/voice-call",
    };
    const onTimeout = vi.fn(async () => {});

    startMaxDurationTimer({
      ctx: ctx as never,
      callId: "call-1",
      onTimeout,
    });

    expect(ctx.maxDurationTimers.has("call-1")).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(call).toEqual({ id: "call-1", state: "active", endReason: "timeout" });
    expect(persistCallRecordMock).toHaveBeenCalledWith("/tmp/voice-call", call);
    expect(onTimeout).toHaveBeenCalledWith("call-1");
    expect(ctx.maxDurationTimers.has("call-1")).toBe(false);

    startMaxDurationTimer({
      ctx: ctx as never,
      callId: "call-1",
      onTimeout,
    });
    clearMaxDurationTimer(ctx as never, "call-1");
    expect(ctx.maxDurationTimers.has("call-1")).toBe(false);
  });

  it("does not time out terminal calls", async () => {
    const ctx = {
      activeCalls: new Map([["call-1", { id: "call-1", state: "completed" }]]),
      maxDurationTimers: new Map(),
      config: { maxDurationSeconds: 5 },
      storePath: "/tmp/voice-call",
    };
    const onTimeout = vi.fn(async () => {});

    startMaxDurationTimer({
      ctx: ctx as never,
      callId: "call-1",
      onTimeout,
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(persistCallRecordMock).not.toHaveBeenCalled();
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("waits for transcripts, resolves matching tokens, rejects mismatches and timeouts", async () => {
    const ctx = {
      transcriptWaiters: new Map(),
      config: { transcriptTimeoutMs: 1_000 },
    };

    const pending = waitForFinalTranscript(ctx as never, "call-1", "turn-1");
    expect(resolveTranscriptWaiter(ctx as never, "call-1", "ignored", "turn-2")).toBe(false);
    expect(resolveTranscriptWaiter(ctx as never, "call-1", "final transcript", "turn-1")).toBe(
      true,
    );
    await expect(pending).resolves.toBe("final transcript");

    const another = waitForFinalTranscript(ctx as never, "call-2");
    rejectTranscriptWaiter(ctx as never, "call-2", "provider failed");
    await expect(another).rejects.toThrow("provider failed");

    const timedOut = waitForFinalTranscript(ctx as never, "call-3").catch((error) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const timeoutError = await timedOut;
    expect(timeoutError).toBeInstanceOf(Error);
    expect((timeoutError as Error).message).toBe("Timed out waiting for transcript after 1000ms");

    const toClear = waitForFinalTranscript(ctx as never, "call-4");
    clearTranscriptWaiter(ctx as never, "call-4");
    expect(ctx.transcriptWaiters.has("call-4")).toBe(false);
    void toClear.catch(() => {});
  });

  it("rejects duplicate transcript waiters for the same call", async () => {
    const ctx = {
      transcriptWaiters: new Map(),
      config: { transcriptTimeoutMs: 1_000 },
    };

    const pending = waitForFinalTranscript(ctx as never, "call-1");
    await expect(waitForFinalTranscript(ctx as never, "call-1")).rejects.toThrow(
      "Already waiting for transcript",
    );
    rejectTranscriptWaiter(ctx as never, "call-1", "done");
    await expect(pending).rejects.toThrow("done");
  });
});

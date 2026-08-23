// Tests prepared reply queue state resolution before get-reply starts a run.
import { describe, expect, it, vi } from "vitest";
import { resolvePreparedReplyQueueState } from "./get-reply-run-queue.js";

describe("resolvePreparedReplyQueueState", () => {
  it("continues immediately when queue policy does not require waiting", async () => {
    const resolveBusyState = vi.fn(() => ({
      activeSessionId: undefined,
      isActive: false,
      isStreaming: false,
    }));

    const result = await resolvePreparedReplyQueueState({
      activeRunQueueAction: "enqueue-followup",
      activeSessionId: undefined,
      queueMode: "followup",
      sessionKey: "session-key",
      sessionId: "session-1",
      abortActiveRun: vi.fn(),
      waitForActiveRunEnd: vi.fn(),
      refreshPreparedState: vi.fn(),
      resolveBusyState,
    });

    expect(result).toEqual({
      kind: "continue",
      busyState: { activeSessionId: undefined, isActive: false, isStreaming: false },
    });
    expect(resolveBusyState).toHaveBeenCalledOnce();
  });

  it("aborts and waits for interrupt mode before continuing", async () => {
    const abortActiveRun = vi.fn(() => true);
    const waitForActiveRunEnd = vi.fn(async () => undefined);
    const refreshPreparedState = vi.fn(async () => undefined);
    const resolveBusyState = vi.fn(() => ({
      activeSessionId: undefined,
      isActive: false,
      isStreaming: false,
    }));

    const result = await resolvePreparedReplyQueueState({
      activeRunQueueAction: "run-now",
      activeSessionId: "session-active",
      queueMode: "interrupt",
      sessionKey: "session-key",
      sessionId: "session-1",
      abortActiveRun,
      waitForActiveRunEnd,
      refreshPreparedState,
      resolveBusyState,
    });

    expect(abortActiveRun).toHaveBeenCalledWith("session-active");
    expect(waitForActiveRunEnd).toHaveBeenCalledWith("session-active");
    expect(refreshPreparedState).toHaveBeenCalledOnce();
    expect(result).toEqual({
      kind: "continue",
      busyState: { activeSessionId: undefined, isActive: false, isStreaming: false },
    });
  });

  it("rechecks after wait and returns shutdown reply when still busy", async () => {
    const result = await resolvePreparedReplyQueueState({
      activeRunQueueAction: "run-now",
      activeSessionId: "session-active",
      queueMode: "interrupt",
      sessionKey: "session-key",
      sessionId: "session-1",
      abortActiveRun: vi.fn(() => true),
      waitForActiveRunEnd: vi.fn(async () => undefined),
      refreshPreparedState: vi.fn(async () => undefined),
      resolveBusyState: () => ({
        activeSessionId: "session-after-wait",
        isActive: true,
        isStreaming: false,
      }),
    });

    expect(result).toEqual({
      kind: "reply",
      reply: {
        text: "⚠️ Previous run is still shutting down. Please try again in a moment.",
      },
    });
  });
});

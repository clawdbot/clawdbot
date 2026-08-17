import { afterEach, describe, expect, it, vi } from "vitest";
import { handleDynamicToolCallWithTimeout } from "./dynamic-tool-execution.js";

describe("dynamic tool owner timeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("retains the concrete tool owner when timeout wins before a snapshot", async () => {
    vi.useFakeTimers();
    const ownerKey = '["memory-lancedb","memory_store"]';
    const observeToolTerminal = vi.fn(() => ({
      executionStarted: true,
      sideEffectEvidence: true,
    }));
    const response = handleDynamicToolCallWithTimeout({
      call: {
        threadId: "thread-1",
        turnId: "turn-1",
        callId: "call-owner-timeout",
        namespace: null,
        tool: "memory_store",
        arguments: { text: "Tuesday 09:00 release window" },
      },
      toolBridge: {
        handleToolCall: vi.fn(() => new Promise<never>(() => {})),
        consumeToolExecutionSnapshot: vi.fn(() => undefined),
        sideEffectOwnerKeyForTool: vi.fn(() => ownerKey),
      },
      signal: new AbortController().signal,
      timeoutMs: 1,
      observeToolTerminal,
    });

    await vi.advanceTimersByTimeAsync(1);

    await expect(response).resolves.toMatchObject({ success: false });
    expect(observeToolTerminal).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerMutation: { ownerKey },
        outcome: "failure",
      }),
    );
  });
});

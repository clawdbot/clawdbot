// Runtime proof: Codex computer wait/hold_key outer watchdog uses the same
// duration grammar as computer-tool (parseStrictFiniteNumber), observed through
// the production resolve → handleDynamicToolCallWithTimeout chain used by
// run-attempt-server-requests.ts (dynamic tool request handler).
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  handleDynamicToolCallWithTimeout,
  resolveDynamicToolCallTimeoutMs,
} from "./dynamic-tool-execution.js";
import type { CodexDynamicToolCallParams } from "./protocol.js";

function makeComputerCall(
  action: "wait" | "hold_key",
  duration: string | number,
  callId: string,
): CodexDynamicToolCallParams {
  return {
    threadId: "thread-proof",
    turnId: "turn-proof",
    callId,
    namespace: null,
    tool: "computer",
    arguments: { action, duration },
  };
}

async function observeWatchdogTimeout(params: {
  call: CodexDynamicToolCallParams;
  timeoutMs: number;
}): Promise<{ timedOutAtMs: number; responseText: string }> {
  const onTimeout = vi.fn();
  const responsePromise = handleDynamicToolCallWithTimeout({
    call: params.call,
    toolBridge: {
      // Hang forever so the outer watchdog is the only terminal path.
      handleToolCall: vi.fn(() => new Promise<never>(() => {})),
    },
    signal: new AbortController().signal,
    timeoutMs: params.timeoutMs,
    onTimeout,
  });

  // One ms before the deadline: still running.
  await vi.advanceTimersByTimeAsync(Math.max(0, params.timeoutMs - 1));
  expect(onTimeout).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(1);
  const response = await responsePromise;
  expect(onTimeout).toHaveBeenCalledTimes(1);
  expect(response.success).toBe(false);
  expect(response.diagnosticTerminalReason).toBe("timed_out");
  const firstItem = response.contentItems[0];
  const responseText =
    firstItem && "text" in firstItem && typeof firstItem.text === "string" ? firstItem.text : "";
  return { timedOutAtMs: params.timeoutMs, responseText };
}

describe("Codex computer duration watchdog runtime proof", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("rejects hex duration at baseline and honors scientific/fractional duration on the app-server execution path", async () => {
    vi.useFakeTimers();

    const hexCall = makeComputerCall("wait", "0x10", "call-computer-wait-hex");
    const sciCall = makeComputerCall("hold_key", "1e2", "call-computer-hold-sci");
    const fractionCall = makeComputerCall("wait", "0.5", "call-computer-wait-fraction");

    // Same entry used by run-attempt-server-requests.ts before handleDynamicToolCallWithTimeout.
    const hexTimeoutMs = resolveDynamicToolCallTimeoutMs({
      call: hexCall,
      config: undefined,
    });
    const sciTimeoutMs = resolveDynamicToolCallTimeoutMs({
      call: sciCall,
      config: undefined,
    });
    const fractionTimeoutMs = resolveDynamicToolCallTimeoutMs({
      call: fractionCall,
      config: undefined,
    });

    // Broken Number("0x10")===16 would inflate wait baseline 120_000 → 136_000.
    expect(hexTimeoutMs).toBe(120_000);
    // Scientific "1e2" (100s) is honored for hold_key outer budget.
    expect(sciTimeoutMs).toBe(250_000);
    // Fractional "0.5" (0.5s) is honored for wait outer budget.
    expect(fractionTimeoutMs).toBe(120_500);

    const hexWatchdog = await observeWatchdogTimeout({
      call: hexCall,
      timeoutMs: hexTimeoutMs,
    });
    const sciWatchdog = await observeWatchdogTimeout({
      call: sciCall,
      timeoutMs: sciTimeoutMs,
    });
    const fractionWatchdog = await observeWatchdogTimeout({
      call: fractionCall,
      timeoutMs: fractionTimeoutMs,
    });

    expect(hexWatchdog.responseText).toContain("120000ms");
    expect(sciWatchdog.responseText).toContain("250000ms");
    expect(fractionWatchdog.responseText).toContain("120500ms");

    process.stdout.write(
      `[codex computer-duration watchdog proof] ${JSON.stringify({
        entry: "resolveDynamicToolCallTimeoutMs",
        chain:
          "run-attempt-server-requests.ts -> resolveDynamicToolCallTimeoutMs -> handleDynamicToolCallWithTimeout",
        hex: {
          duration: "0x10",
          action: "wait",
          timeoutMs: hexTimeoutMs,
          timed_out_at_ms: hexWatchdog.timedOutAtMs,
          number_coercion_would_have_been_ms: 136_000,
          response_mentions_timeout: hexWatchdog.responseText.includes("120000ms"),
        },
        scientific: {
          duration: "1e2",
          action: "hold_key",
          timeoutMs: sciTimeoutMs,
          timed_out_at_ms: sciWatchdog.timedOutAtMs,
          response_mentions_timeout: sciWatchdog.responseText.includes("250000ms"),
        },
        fractional: {
          duration: "0.5",
          action: "wait",
          timeoutMs: fractionTimeoutMs,
          timed_out_at_ms: fractionWatchdog.timedOutAtMs,
          response_mentions_timeout: fractionWatchdog.responseText.includes("120500ms"),
        },
      })}\n`,
    );
  });
});

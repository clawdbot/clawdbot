import { Stream } from "openai/streaming";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn,
  })),
}));

import { buildTimeoutAbortSignal } from "./fetch-timeout.js";

describe("buildTimeoutAbortSignal", () => {
  beforeEach(() => {
    warn.mockClear();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("logs when its own timeout aborts the signal", async () => {
    const { signal, cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 25,
      operation: "unit-test",
      url: "https://user:pass@example.com/v1/responses?api-key=secret#fragment",
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(signal?.aborted).toBe(true);
    expect(signal?.reason).toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "fetch timeout reached; aborting operation",
      expect.objectContaining({
        timeoutMs: 25,
        operation: "unit-test",
        url: "https://example.com/v1/responses",
        consoleMessage:
          "fetch timeout after 25ms (elapsed 25ms) operation=unit-test url=https://example.com/v1/responses",
      }),
    );

    cleanup();
  });

  it("keeps timeout aborts visible to OpenAI SSE streams instead of cleanly ending", async () => {
    const { signal, cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 25,
      operation: "unit-test",
    });
    const encoder = new TextEncoder();
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('data: {"ok": true}\n\n'));
          signal?.addEventListener(
            "abort",
            () => controller.error(signal.reason ?? new Error("request timed out")),
            { once: true },
          );
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );

    const iterator = Stream.fromSSEResponse(response, new AbortController())[
      Symbol.asyncIterator
    ]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { ok: true },
    });
    const pending = iterator.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);

    await expect(pending).resolves.toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });

    cleanup();
  });

  it("annotates timeout logs when the timer fires late", async () => {
    vi.setSystemTime(0);
    const { cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 25,
      operation: "unit-test",
      url: "https://example.com/v1/responses",
    });

    vi.setSystemTime(2_000);
    await vi.advanceTimersByTimeAsync(25);

    expect(warn).toHaveBeenCalledWith(
      "fetch timeout reached; aborting operation",
      expect.objectContaining({
        timerDelayMs: 2000,
        eventLoopDelayHint: "timer delayed 2000ms, likely event-loop starvation",
        consoleMessage: expect.stringContaining(
          "timer delayed 2000ms, likely event-loop starvation",
        ),
      }),
    );

    cleanup();
  });

  it("strips query strings and hashes from relative timeout URL logs", async () => {
    const { cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 25,
      operation: "unit-test",
      url: "/api/responses?api-key=secret#fragment",
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(warn).toHaveBeenCalledWith(
      "fetch timeout reached; aborting operation",
      expect.objectContaining({
        url: "/api/responses",
      }),
    );

    cleanup();
  });

  it("does not log when a parent signal aborts first", async () => {
    const parent = new AbortController();
    const { signal, cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 25,
      signal: parent.signal,
      operation: "unit-test",
    });

    parent.abort();
    await vi.advanceTimersByTimeAsync(25);

    expect(signal?.aborted).toBe(true);
    expect(warn).not.toHaveBeenCalled();

    cleanup();
  });

  it("refreshes its timeout when progress is observed", async () => {
    const { signal, refresh, cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 25,
      operation: "unit-test",
    });

    await vi.advanceTimersByTimeAsync(20);
    refresh();
    await vi.advanceTimersByTimeAsync(24);

    expect(signal?.aborted).toBe(false);
    expect(warn).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);

    expect(signal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);

    cleanup();
  });
});

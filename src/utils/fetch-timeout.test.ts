import { Stream } from "openai/streaming";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({
    warn,
  })),
}));

import { buildTimeoutAbortSignal } from "./fetch-timeout.js";

function requireWarnCall(callIndex: number): [string, Record<string, unknown>] {
  const call = warn.mock.calls[callIndex];
  if (!call) {
    throw new Error(`missing warning call ${callIndex}`);
  }
  const [message, record] = call;
  if (typeof message !== "string" || !record || typeof record !== "object") {
    throw new Error(`invalid warning call ${callIndex}`);
  }
  return [message, record as Record<string, unknown>];
}

function requireWarnMessage(callIndex: number): string {
  const [message] = requireWarnCall(callIndex);
  return message;
}

function requireWarnRecord(callIndex: number): Record<string, unknown> {
  const [, record] = requireWarnCall(callIndex);
  return record;
}

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
    expect((signal?.reason as Error | undefined)?.name).toBe("TimeoutError");
    expect((signal?.reason as Error | undefined)?.message).toBe("request timed out");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(requireWarnMessage(0)).toBe("fetch timeout reached; aborting operation");
    const record = requireWarnRecord(0);
    expect(record.timeoutMs).toBe(25);
    expect(record.operation).toBe("unit-test");
    expect(record.url).toBe("https://example.com/v1/responses");
    expect(record.consoleMessage).toBe(
      "fetch timeout after 25ms (elapsed 25ms) operation=unit-test url=https://example.com/v1/responses",
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

    const firstChunk = await iterator.next();
    expect(firstChunk.done).toBe(false);
    expect(firstChunk.value).toEqual({ ok: true });
    const pending = iterator.next().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(25);

    const timeoutError = (await pending) as Error;
    expect(timeoutError.name).toBe("TimeoutError");
    expect(timeoutError.message).toBe("request timed out");

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

    expect(requireWarnMessage(0)).toBe("fetch timeout reached; aborting operation");
    const record = requireWarnRecord(0);
    expect(record.timerDelayMs).toBe(2000);
    expect(record.eventLoopDelayHint).toBe("timer delayed 2000ms, likely event-loop starvation");
    expect(String(record.consoleMessage)).toContain(
      "timer delayed 2000ms, likely event-loop starvation",
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

    expect(requireWarnMessage(0)).toBe("fetch timeout reached; aborting operation");
    expect(requireWarnRecord(0).url).toBe("/api/responses");

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

  it("emits a warning without operation or url when callers omit context (#79195)", async () => {
    const { signal, cleanup } = buildTimeoutAbortSignal({
      timeoutMs: 25,
    });

    await vi.advanceTimersByTimeAsync(25);

    expect(signal?.aborted).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const record = requireWarnRecord(0);
    expect(record).not.toHaveProperty("operation");
    expect(record).not.toHaveProperty("url");
    expect(record.consoleMessage).toBe("fetch timeout after 25ms (elapsed 25ms)");

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

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TelegramTransport } from "./fetch.js";
import { TelegramPollingTransportState } from "./polling-transport-state.js";

type LogFn = (line: string) => void;
type LogSpy = ReturnType<typeof vi.fn<LogFn>>;

function makeMockTransport(label = "transport"): TelegramTransport & {
  close: ReturnType<typeof vi.fn<() => Promise<void>>>;
} {
  return {
    fetch: (async () => new Response(`ok-${label}`)) as typeof fetch,
    sourceFetch: (async () => new Response(`ok-${label}`)) as typeof fetch,
    close: vi.fn<() => Promise<void>>(async () => undefined),
  };
}

function anyLogMatches(log: LogSpy, fragment: string): boolean {
  return log.mock.calls.some((call) => {
    const first = call[0];
    return typeof first === "string" && first.includes(fragment);
  });
}

async function flushMicrotasks() {
  // The dirty-rebuild path fires close() without awaiting it so the polling
  // cycle is not blocked; tests must flush microtasks before asserting on it.
  await Promise.resolve();
  await Promise.resolve();
}

describe("TelegramPollingTransportState", () => {
  let log: LogSpy;
  beforeEach(() => {
    log = vi.fn<LogFn>();
  });

  it("returns the initial transport when not dirty", () => {
    const initial = makeMockTransport("initial");
    const state = new TelegramPollingTransportState({
      log,
      initialTransport: initial,
    });

    const acquired = state.acquireForNextCycle();

    expect(acquired).toBe(initial);
    expect(initial.close).not.toHaveBeenCalled();
  });

  it("closes the stale transport when a dirty rebuild replaces it", async () => {
    const initial = makeMockTransport("initial");
    const rebuilt = makeMockTransport("rebuilt");
    const createTelegramTransport = vi.fn(() => rebuilt);
    const state = new TelegramPollingTransportState({
      log,
      initialTransport: initial,
      createTelegramTransport,
    });

    state.markDirty();
    const acquired = state.acquireForNextCycle();

    expect(acquired).toBe(rebuilt);
    await flushMicrotasks();
    expect(initial.close).toHaveBeenCalledTimes(1);
    expect(rebuilt.close).not.toHaveBeenCalled();
    expect(anyLogMatches(log, "closing stale transport")).toBe(true);
  });

  it("does not close when dirty rebuild keeps the same transport instance", async () => {
    const initial = makeMockTransport("initial");
    // createTelegramTransport returns the same instance — e.g., factory returned null → fallback to previous
    const createTelegramTransport = vi.fn(() => initial);
    const state = new TelegramPollingTransportState({
      log,
      initialTransport: initial,
      createTelegramTransport,
    });

    state.markDirty();
    state.acquireForNextCycle();

    await flushMicrotasks();
    expect(initial.close).not.toHaveBeenCalled();
  });

  it("dispose() closes the currently-held transport and blocks until close resolves", async () => {
    const initial = makeMockTransport("initial");
    const state = new TelegramPollingTransportState({
      log,
      initialTransport: initial,
    });
    // Force the state to promote the initial transport into the held slot.
    state.acquireForNextCycle();

    let closeResolved = false;
    initial.close.mockImplementationOnce(async () => {
      await Promise.resolve();
      closeResolved = true;
    });

    await state.dispose();

    expect(initial.close).toHaveBeenCalledTimes(1);
    expect(closeResolved).toBe(true);
  });

  it("dispose() is idempotent and safe with no transport", async () => {
    const state = new TelegramPollingTransportState({ log });
    await expect(state.dispose()).resolves.toBeUndefined();
    await expect(state.dispose()).resolves.toBeUndefined();
  });

  it("dispose() swallows errors thrown by transport.close()", async () => {
    const initial = makeMockTransport("initial");
    initial.close.mockRejectedValueOnce(new Error("boom"));
    const state = new TelegramPollingTransportState({
      log,
      initialTransport: initial,
    });
    state.acquireForNextCycle();

    await expect(state.dispose()).resolves.toBeUndefined();
    expect(anyLogMatches(log, "failed to close transport during dispose")).toBe(true);
  });

  it("acquireForNextCycle() returns undefined after dispose()", async () => {
    const initial = makeMockTransport("initial");
    const createTelegramTransport = vi.fn(() => makeMockTransport("rebuilt"));
    const state = new TelegramPollingTransportState({
      log,
      initialTransport: initial,
      createTelegramTransport,
    });

    await state.dispose();

    const acquired = state.acquireForNextCycle();
    expect(acquired).toBeUndefined();
    expect(createTelegramTransport).not.toHaveBeenCalled();
  });

  it("clears the dirty flag even when no factory is configured", () => {
    const initial = makeMockTransport("initial");
    const state = new TelegramPollingTransportState({
      log,
      initialTransport: initial,
    });
    state.markDirty();

    const acquired = state.acquireForNextCycle();

    expect(acquired).toBe(initial);
    // Next cycle without markDirty should not trigger another rebuild log.
    state.acquireForNextCycle();
    const rebuildLogs = log.mock.calls.filter((call) => {
      const line = call[0];
      return typeof line === "string" && line.includes("rebuilding transport");
    });
    expect(rebuildLogs.length).toBeLessThanOrEqual(1);
  });
});

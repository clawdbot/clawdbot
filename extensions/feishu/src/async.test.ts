import { afterEach, describe, expect, it, vi } from "vitest";
import { waitForAbortableDelay } from "./async.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("waitForAbortableDelay", () => {
  it("resolves false immediately when aborted during backoff", async () => {
    vi.useFakeTimers();
    const abortController = new AbortController();

    const delay = waitForAbortableDelay(60_000, abortController.signal);
    abortController.abort();

    await expect(delay).resolves.toBe(false);
  });

  it("resolves true after the full delay when not aborted", async () => {
    vi.useFakeTimers();

    const delay = waitForAbortableDelay(500);
    await vi.advanceTimersByTimeAsync(500);

    await expect(delay).resolves.toBe(true);
  });
});

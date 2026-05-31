import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildOAuthRequestSignal } from "./abort.js";

describe("buildOAuthRequestSignal", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("caps oversized request timeouts before creating an abort signal", () => {
    const timeoutController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);

    const signal = buildOAuthRequestSignal({ timeoutMs: Number.MAX_SAFE_INTEGER });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(signal).toBe(timeoutController.signal);
  });

  it("combines caller abort signals with the capped timeout signal", () => {
    const callerController = new AbortController();
    const timeoutController = new AbortController();
    const combinedController = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    const anySpy = vi.spyOn(AbortSignal, "any").mockReturnValue(combinedController.signal);

    const signal = buildOAuthRequestSignal({
      signal: callerController.signal,
      timeoutMs: Number.MAX_SAFE_INTEGER,
    });

    expect(timeoutSpy).toHaveBeenCalledWith(MAX_TIMER_TIMEOUT_MS);
    expect(anySpy).toHaveBeenCalledWith([callerController.signal, timeoutController.signal]);
    expect(signal).toBe(combinedController.signal);
  });
});

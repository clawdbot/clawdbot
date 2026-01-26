import { describe, expect, it, vi } from "vitest";

import { wrapFetchWithAbortSignal } from "./fetch.js";

describe("wrapFetchWithAbortSignal", () => {
  it("adds duplex for requests with a body", async () => {
    let seenInit: RequestInit | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenInit = init;
      return {} as Response;
    });

    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    await wrapped("https://example.com", { method: "POST", body: "hi" });

    expect(seenInit?.duplex).toBe("half");
  });

  it("converts foreign abort signals to native controllers", async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return {} as Response;
    });

    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    let abortHandler: (() => void) | null = null;
    const fakeSignal = {
      aborted: false,
      addEventListener: (event: string, handler: () => void) => {
        if (event === "abort") abortHandler = handler;
      },
      removeEventListener: (event: string, handler: () => void) => {
        if (event === "abort" && abortHandler === handler) abortHandler = null;
      },
    } as AbortSignal;

    const promise = wrapped("https://example.com", { signal: fakeSignal });
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(fakeSignal);

    abortHandler?.();
    expect(seenSignal?.aborted).toBe(true);

    await promise;
  });
});

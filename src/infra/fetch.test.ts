import { describe, expect, it, vi } from "vitest";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import { resolveFetch, wrapFetchWithAbortSignal } from "./fetch.js";

async function waitForMicrotaskTurn(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
}

function createForeignSignalHarness() {
  let abortHandler: (() => void) | null = null;
  const removeEventListener = vi.fn((event: string, handler: () => void) => {
    if (event === "abort" && abortHandler === handler) {
      abortHandler = null;
    }
  });

  const fakeSignal = {
    aborted: false,
    addEventListener: (event: string, handler: () => void) => {
      if (event === "abort") {
        abortHandler = handler;
      }
    },
    removeEventListener,
  } as unknown as AbortSignal;

  return {
    fakeSignal,
    removeEventListener,
    triggerAbort: () => abortHandler?.(),
  };
}

function createThrowingCleanupSignalHarness(cleanupError: Error) {
  const removeEventListener = vi.fn(() => {
    throw cleanupError;
  });
  const fakeSignal = {
    aborted: false,
    addEventListener: (_event: string, _handler: () => void) => {},
    removeEventListener,
  } as unknown as AbortSignal;
  return { fakeSignal, removeEventListener };
}

function createSeenInitFetch() {
  let seenInit: RequestInit | undefined;
  const fetchImpl = withFetchPreconnect(
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenInit = init;
      return {} as Response;
    }),
  );
  return { fetchImpl, getSeenInit: () => seenInit };
}

function createSeenSignalFetch() {
  let seenSignal: AbortSignal | undefined;
  const fetchImpl = withFetchPreconnect(
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      seenSignal = init?.signal as AbortSignal | undefined;
      return {} as Response;
    }),
  );
  return { fetchImpl, getSeenSignal: () => seenSignal };
}

function createSymbolHeaderInit(enumerable: boolean): RequestInit {
  const headers = { "Content-Type": "application/json" } as Record<string, string> & {
    [key: symbol]: unknown;
  };
  Object.defineProperty(headers, Symbol("sensitiveHeaders"), {
    value: new Set(["content-type"]),
    enumerable,
  });
  return { headers };
}

describe("wrapFetchWithAbortSignal", () => {
  it("adds duplex for requests with a body", async () => {
    const { fetchImpl, getSeenInit } = createSeenInitFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    await wrapped("https://example.com", { method: "POST", body: "hi" });

    expect((getSeenInit() as (RequestInit & { duplex?: string }) | undefined)?.duplex).toBe("half");
  });

  it("adds duplex when the input Request already carries the body", async () => {
    const { fetchImpl, getSeenInit } = createSeenInitFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    await wrapped(new Request("https://example.com", { method: "POST", body: "hi" }));

    expect((getSeenInit() as (RequestInit & { duplex?: string }) | undefined)?.duplex).toBe("half");
  });

  it("preserves an existing duplex init field", async () => {
    const { fetchImpl, getSeenInit } = createSeenInitFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    await wrapped("https://example.com", {
      method: "POST",
      body: "hi",
      duplex: "half",
    } as RequestInit & { duplex: "half" });

    expect((getSeenInit() as (RequestInit & { duplex?: string }) | undefined)?.duplex).toBe("half");
  });

  it("converts foreign abort signals to native controllers", async () => {
    const { fetchImpl, getSeenSignal } = createSeenSignalFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const { fakeSignal, triggerAbort } = createForeignSignalHarness();

    const promise = wrapped("https://example.com", { signal: fakeSignal });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const seenSignal = getSeenSignal();
    expect(seenSignal).toBeInstanceOf(AbortSignal);
    expect(seenSignal).not.toBe(fakeSignal);

    triggerAbort();
    expect(seenSignal?.aborted).toBe(true);

    await promise;
  });

  it("does not emit an extra unhandled rejection when wrapped fetch rejects", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);

    const fetchError = new TypeError("fetch failed");
    const fetchImpl = withFetchPreconnect(
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.reject(fetchError)),
    );
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const { fakeSignal, removeEventListener } = createForeignSignalHarness();

    try {
      await expect(wrapped("https://example.com", { signal: fakeSignal })).rejects.toBe(fetchError);
      await Promise.resolve();
      await waitForMicrotaskTurn();

      expect(unhandled).toStrictEqual([]);
      expect(removeEventListener).toHaveBeenCalledOnce();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("preserves original rejection when listener cleanup throws", async () => {
    const fetchError = new TypeError("fetch failed");
    const cleanupError = new TypeError("cleanup failed");
    const fetchImpl = withFetchPreconnect(
      vi.fn((_input: RequestInfo | URL, _init?: RequestInit) => Promise.reject(fetchError)),
    );
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const { fakeSignal, removeEventListener } = createThrowingCleanupSignalHarness(cleanupError);

    await expect(wrapped("https://example.com", { signal: fakeSignal })).rejects.toBe(fetchError);
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it.each([
    {
      name: "cleans up listener and rethrows when fetch throws synchronously",
      makeSignalHarness: () => createForeignSignalHarness(),
    },
    {
      name: "preserves original sync throw when listener cleanup throws",
      makeSignalHarness: () => createThrowingCleanupSignalHarness(new TypeError("cleanup failed")),
    },
  ])("$name", ({ makeSignalHarness }) => {
    const syncError = new TypeError("sync fetch failure");
    const fetchImpl = withFetchPreconnect(
      vi.fn(() => {
        throw syncError;
      }),
    );
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const { fakeSignal, removeEventListener } = makeSignalHarness();

    expect(() => wrapped("https://example.com", { signal: fakeSignal })).toThrow(syncError);
    expect(removeEventListener).toHaveBeenCalledOnce();
  });

  it("skips listener cleanup when foreign signal is already aborted", async () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const fetchImpl = withFetchPreconnect(vi.fn(async () => ({ ok: true }) as Response));
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const fakeSignal = {
      aborted: true,
      addEventListener,
      removeEventListener,
    } as unknown as AbortSignal;

    await wrapped("https://example.com", { signal: fakeSignal });

    expect(addEventListener).not.toHaveBeenCalled();
    expect(removeEventListener).not.toHaveBeenCalled();
  });

  it("passes through foreign signal-like objects without addEventListener", async () => {
    const { fetchImpl, getSeenSignal } = createSeenSignalFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    const fakeSignal = {
      aborted: false,
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;

    await wrapped("https://example.com", { signal: fakeSignal });

    expect(getSeenSignal()).toBe(fakeSignal);
  });

  it("passes through native AbortSignal instances unchanged", async () => {
    const { fetchImpl, getSeenSignal } = createSeenSignalFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);
    const controller = new AbortController();

    await wrapped("https://example.com", { signal: controller.signal });

    expect(getSeenSignal()).toBe(controller.signal);
  });

  it("passes through foreign signals unchanged when AbortController is unavailable", async () => {
    const { fetchImpl, getSeenSignal } = createSeenSignalFetch();
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);
    const fakeSignal = {
      aborted: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as AbortSignal;
    const previousAbortController = globalThis.AbortController;
    vi.stubGlobal("AbortController", undefined);

    try {
      await wrapped("https://example.com", { signal: fakeSignal });
    } finally {
      vi.stubGlobal("AbortController", previousAbortController);
    }

    expect(getSeenSignal()).toBe(fakeSignal);
  });

  it("returns the same function when called with an already wrapped fetch", () => {
    const fetchImpl = withFetchPreconnect(vi.fn(async () => ({ ok: true }) as Response));
    const wrapped = wrapFetchWithAbortSignal(fetchImpl);

    expect(wrapFetchWithAbortSignal(wrapped)).toBe(wrapped);
    expect(resolveFetch(wrapped)).toBe(wrapped);
  });

  it("keeps preconnect bound to the original fetch implementation", () => {
    const preconnectSpy = vi.fn(function (this: unknown) {
      return this;
    });
    const fetchImpl = vi.fn(async () => ({ ok: true }) as Response) as unknown as typeof fetch & {
      preconnect: (url: string, init?: { credentials?: RequestCredentials }) => unknown;
    };
    fetchImpl.preconnect = preconnectSpy;

    const wrapped = wrapFetchWithAbortSignal(fetchImpl) as typeof fetch & {
      preconnect: (url: string, init?: { credentials?: RequestCredentials }) => unknown;
    };

    const seenThis = wrapped.preconnect("https://example.com");

    expect(preconnectSpy).toHaveBeenCalledOnce();
    expect(seenThis).toBe(fetchImpl);
  });

  it("exposes a no-op preconnect when the source fetch has none", () => {
    const fetchImpl = withFetchPreconnect(vi.fn(async () => ({ ok: true }) as Response));
    const wrapped = wrapFetchWithAbortSignal(fetchImpl) as typeof fetch & {
      preconnect: (url: string, init?: { credentials?: RequestCredentials }) => unknown;
    };

    expect(wrapped.preconnect("https://example.com")).toBeUndefined();
  });

  it.each([
    { enumerable: true, name: "enumerable" },
    { enumerable: false, name: "non-enumerable" },
  ])(
    "drops $name header symbol metadata before calling the wrapped fetch",
    async ({ enumerable }) => {
      const { fetchImpl, getSeenInit } = createSeenInitFetch();
      const wrapped = wrapFetchWithAbortSignal(fetchImpl);
      const init = createSymbolHeaderInit(enumerable);

      await wrapped("https://example.com", init);

      const seenHeaders = getSeenInit()?.headers;
      expect(seenHeaders).not.toBe(init.headers);
      expect(Object.getOwnPropertySymbols(seenHeaders as object)).toStrictEqual([]);
      expect(new Headers(seenHeaders).get("content-type")).toBe("application/json");
      expect(Object.getOwnPropertySymbols(init.headers as object)).toHaveLength(1);
    },
  );
});

describe("resolveFetch", () => {
  it("returns undefined when neither an explicit nor global fetch exists", () => {
    const previousFetch = globalThis.fetch;
    vi.stubGlobal("fetch", undefined);
    try {
      expect(resolveFetch(undefined)).toBeUndefined();
    } finally {
      vi.stubGlobal("fetch", previousFetch);
    }
  });
});

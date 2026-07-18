import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installMissingStylesheetRecovery,
  installStaleChunkReloadListener,
  isStaleChunkImportError,
  retryStaleChunkReload,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

const GUARD_KEY = "openclaw.controlUi.staleChunkReloadBuildId";
const PROBE_TIMEOUT_MS = 3_000;

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => {
    throw new Error("deferred promise was not initialized");
  };
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}

function stubDocumentFetch(...responses: Response[]) {
  const fetchMock = vi.fn<typeof fetch>(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error("unexpected document probe");
    }
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubHangingDocumentFetch() {
  const fetchMock = vi.fn<typeof fetch>(
    async (_input, init) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          return;
        }
        signal.addEventListener("abort", () => reject(new Error("document probe aborted")), {
          once: true,
        });
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("isStaleChunkImportError", () => {
  it.each([
    "Importing a module script failed.",
    "Failed to fetch dynamically imported module: http://x/assets/usage-abc123.js",
    "error loading dynamically imported module",
    "Unable to preload CSS for /assets/usage-abc123.css",
  ])("matches module import failures: %s", (message) => {
    expect(isStaleChunkImportError(new Error(message))).toBe(true);
  });

  it("ignores unrelated errors and non-error values", () => {
    expect(isStaleChunkImportError(new Error("request failed"))).toBe(false);
    expect(isStaleChunkImportError("Importing a module script failed.")).toBe(false);
    expect(isStaleChunkImportError(undefined)).toBe(false);
  });
});

describe("scheduleStaleChunkReload", () => {
  it("reloads once the document probe succeeds and records the build guard", async () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    stubDocumentFetch(new Response(null, { status: 200 }));
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        buildId: "build-a",
        storage,
        reload,
      }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe("build-a");
  });

  it("never auto-reloads twice for the same build, but recovers on a newer build", async () => {
    const reload = vi.fn();
    const storage = memoryStorage({ [GUARD_KEY]: "build-a" });
    stubDocumentFetch(new Response(null, { status: 200 }));
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        buildId: "build-a",
        storage,
        reload,
      }),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    await expect(
      scheduleStaleChunkReload({
        now: () => 7000,
        buildId: "build-b",
        storage,
        reload,
      }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe("build-b");
  });

  it("does not reload or set the guard while the gateway is unreachable", async () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    stubDocumentFetch(new Response(null, { status: 503 }));
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        storage,
        reload,
      }),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(GUARD_KEY)).toBeNull();
  });

  it("does not auto-reload when the guard cannot be persisted", async () => {
    const reload = vi.fn();
    stubDocumentFetch(new Response(null, { status: 200 }));
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        storage: null,
        reload,
      }),
    ).resolves.toBe(false);
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        storage: {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota exceeded");
          },
        },
        reload,
      }),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("applies an in-memory cooldown between attempts", async () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    const fetchMock = stubDocumentFetch(
      new Response(null, { status: 503 }),
      new Response(null, { status: 200 }),
    );
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        storage,
        reload,
      }),
    ).resolves.toBe(false);
    await expect(scheduleStaleChunkReload({ now: () => 2000, storage, reload })).resolves.toBe(
      false,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await expect(scheduleStaleChunkReload({ now: () => 7000, storage, reload })).resolves.toBe(
      true,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("settles and aborts a hanging document probe after its deadline", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const fetchMock = stubHangingDocumentFetch();
    const retry = retryStaleChunkReload({ reload });

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const result = expect(retry).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    await result;

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("coalesces automatic and manual probes and clears the busy state", async () => {
    const firstProbe = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(async () => firstProbe.promise);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    const storage = memoryStorage();

    const automatic = scheduleStaleChunkReload({ now: () => 1000, storage, reload });
    const manual = retryStaleChunkReload({ reload });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    firstProbe.resolve(new Response(null, { status: 503 }));
    await expect(Promise.all([automatic, manual])).resolves.toEqual([false, false]);
    await expect(retryStaleChunkReload({ reload })).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("retryStaleChunkReload", () => {
  it("reloads without the rate guard when the gateway is reachable", async () => {
    const reload = vi.fn();
    stubDocumentFetch(new Response(null, { status: 200 }));
    await expect(retryStaleChunkReload({ reload })).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload while the gateway is unreachable", async () => {
    const reload = vi.fn();
    stubDocumentFetch(new Response(null, { status: 503 }));
    await expect(retryStaleChunkReload({ reload })).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("installStaleChunkReloadListener", () => {
  function dispatchPreloadError(payload: unknown) {
    const event = new Event("vite:preloadError", { cancelable: true });
    (event as Event & { payload?: unknown }).payload = payload;
    window.dispatchEvent(event);
  }

  it("schedules recovery only for stale-chunk payloads", () => {
    const schedule = vi.fn(async () => false);
    const uninstall = installStaleChunkReloadListener(schedule);
    try {
      dispatchPreloadError(new Error("boom in module evaluation"));
      expect(schedule).not.toHaveBeenCalled();

      dispatchPreloadError(new Error("Importing a module script failed."));
      expect(schedule).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });
});

describe("installMissingStylesheetRecovery", () => {
  function setReadyState(readyState: DocumentReadyState) {
    return vi.spyOn(document, "readyState", "get").mockReturnValue(readyState);
  }

  function dispatchStylesheetError() {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    document.head.append(link);
    link.dispatchEvent(new Event("error"));
    link.remove();
  }

  it("does nothing when the stylesheet sentinel is present and removes listeners", () => {
    setReadyState("complete");
    const schedule = vi.fn(async () => false);
    const uninstall = installMissingStylesheetRecovery({
      isCssApplied: () => true,
      schedule,
    });
    try {
      window.dispatchEvent(new Event("load"));
      dispatchStylesheetError();
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      uninstall();
    }
  });

  it("schedules recovery when the sentinel is missing at load", async () => {
    setReadyState("loading");
    const schedule = vi.fn(async () => true);
    const uninstall = installMissingStylesheetRecovery({
      isCssApplied: () => false,
      schedule,
    });
    try {
      window.dispatchEvent(new Event("load"));
      await Promise.resolve();
      expect(schedule).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  it("shows a reload banner when automatic recovery is unavailable", async () => {
    setReadyState("complete");
    const retry = vi.fn(async () => false);
    const uninstall = installMissingStylesheetRecovery({
      isCssApplied: () => false,
      schedule: vi.fn(async () => false),
      retry,
    });
    try {
      await Promise.resolve();
      const banner = document.querySelector<HTMLElement>('[role="alert"]');
      const reloadButton = banner?.querySelector<HTMLButtonElement>("button");
      expect(banner?.textContent).toContain("Styles failed to load, so the page may look broken.");
      expect(reloadButton?.textContent).toBe("Reload");
      reloadButton?.click();
      expect(retry).toHaveBeenCalledTimes(1);
      expect(banner?.isConnected).toBe(true);
    } finally {
      uninstall();
    }
  });

  it("detects a capture-phase stylesheet error before load", async () => {
    setReadyState("loading");
    const schedule = vi.fn(async () => true);
    const uninstall = installMissingStylesheetRecovery({
      isCssApplied: () => true,
      schedule,
    });
    try {
      dispatchStylesheetError();
      await Promise.resolve();
      expect(schedule).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  it("detects at most once when the resource error and load paths both fire", async () => {
    setReadyState("loading");
    const schedule = vi.fn(async () => true);
    const uninstall = installMissingStylesheetRecovery({
      isCssApplied: () => false,
      schedule,
    });
    try {
      dispatchStylesheetError();
      window.dispatchEvent(new Event("load"));
      await Promise.resolve();
      expect(schedule).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });

  it("uninstall removes the banner and listeners", async () => {
    const readyState = setReadyState("loading");
    const listenerSchedule = vi.fn(async () => true);
    const uninstallListeners = installMissingStylesheetRecovery({
      isCssApplied: () => false,
      schedule: listenerSchedule,
    });
    uninstallListeners();
    dispatchStylesheetError();
    window.dispatchEvent(new Event("load"));
    expect(listenerSchedule).not.toHaveBeenCalled();

    readyState.mockReturnValue("complete");
    const schedule = vi.fn(async () => false);
    const uninstall = installMissingStylesheetRecovery({
      isCssApplied: () => false,
      schedule,
    });
    try {
      await Promise.resolve();
      expect(document.querySelector('[role="alert"]')).not.toBeNull();

      uninstall();
      expect(document.querySelector('[role="alert"]')).toBeNull();
      dispatchStylesheetError();
      window.dispatchEvent(new Event("load"));
      expect(schedule).toHaveBeenCalledTimes(1);
    } finally {
      uninstall();
    }
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { CONTROL_UI_BUILD_INFO } from "../build-info.ts";
import { i18n } from "../i18n/index.ts";
import { registerControlUiReloadGuard } from "./document-reload-guard.ts";
import {
  installMissingStylesheetRecovery,
  installStaleChunkReloadListener,
  isStaleChunkImportError,
  retryStaleChunkReloadWhenReachable,
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

describe("document reload ownership", () => {
  it.each(["automatic", "manual"])(
    "checks live owners before and after the %s document probe",
    async (mode) => {
      const response = deferred<Response>();
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(() => response.promise)
        .mockResolvedValue(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const reload = vi.fn();
      const storage = memoryStorage();
      let allowed = false;
      let clock = 1000;
      const onBlocked = vi.fn();
      const release = registerControlUiReloadGuard(() => allowed, onBlocked);
      const attempt = () =>
        mode === "automatic"
          ? scheduleStaleChunkReload({ storage, reload, now: () => clock })
          : retryStaleChunkReloadWhenReachable({ storage, reload, timeoutMs: 0 });
      try {
        await expect(attempt()).resolves.toBe(false);
        expect(fetchMock).not.toHaveBeenCalled();
        expect(onBlocked).toHaveBeenCalledTimes(mode === "manual" ? 1 : 0);

        allowed = true;
        const pending = attempt();
        expect(fetchMock).toHaveBeenCalledOnce();
        allowed = false;
        response.resolve(new Response(null, { status: 200 }));
        await expect(pending).resolves.toBe(false);
        expect(reload).not.toHaveBeenCalled();
        expect(storage.getItem(GUARD_KEY)).toBeNull();
        expect(onBlocked).toHaveBeenCalledTimes(mode === "manual" ? 2 : 0);

        release();
        clock += 6000;
        await expect(attempt()).resolves.toBe(true);
        expect(reload).toHaveBeenCalledOnce();
      } finally {
        release();
      }
    },
  );

  it("does not release another owner's reload protection", async () => {
    const firstBlocked = vi.fn();
    const secondBlocked = vi.fn();
    const releaseFirst = registerControlUiReloadGuard(() => false, firstBlocked);
    const releaseSecond = registerControlUiReloadGuard(() => false, secondBlocked);
    const probe = vi.fn(async () => true);
    const reload = vi.fn();
    const retry = () =>
      retryStaleChunkReloadWhenReachable({ probe, reload, storage: memoryStorage() });
    try {
      releaseFirst();
      await expect(retry()).resolves.toBe(false);
      expect(probe).not.toHaveBeenCalled();
      expect(firstBlocked).not.toHaveBeenCalled();
      expect(secondBlocked).toHaveBeenCalledOnce();
      releaseSecond();
      await expect(retry()).resolves.toBe(true);
      expect(reload).toHaveBeenCalledOnce();
    } finally {
      releaseFirst();
      releaseSecond();
    }
  });
});

describe("scheduleStaleChunkReload", () => {
  it("keeps generic stale-chunk recovery single-shot after a failed probe", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const fetchMock = stubDocumentFetch(
      new Response(null, { status: 503 }),
      new Response(null, { status: 200 }),
    );
    const pending = scheduleStaleChunkReload({ storage: memoryStorage(), reload });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("does not replace an active Gateway build target with a generic chunk failure", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const storage = memoryStorage();
    stubDocumentFetch(new Response(null, { status: 503 }), new Response(null, { status: 200 }));
    const targeted = scheduleStaleChunkReload({
      buildId: "gateway-target",
      storage,
      reload: () => reload("targeted"),
    });
    await vi.advanceTimersByTimeAsync(0);
    const generic = scheduleStaleChunkReload({ storage, reload: () => reload("generic") });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(Promise.all([targeted, generic])).resolves.toEqual([true, false]);
    expect(reload).toHaveBeenCalledExactlyOnceWith("targeted");
    expect(storage.getItem(GUARD_KEY)).toBe("gateway-target");
  });

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

  it("never lets a persisted build guard suppress recovery for a newer build", async () => {
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
        now: () => 2000,
        buildId: "build-b",
        storage,
        reload,
      }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe("build-b");
  });

  it("stops automatic probes at the deadline without setting the build guard", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const storage = memoryStorage();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = scheduleStaleChunkReload({ buildId: "gateway-target", storage, reload });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(GUARD_KEY)).toBeNull();
    const attempts = fetchMock.mock.calls.length;
    expect(attempts).toBeGreaterThan(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(attempts);
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

  it("applies an in-memory cooldown after bounded recovery expires", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const storage = memoryStorage();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const pending = scheduleStaleChunkReload({ buildId: "build-a", storage, reload });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(pending).resolves.toBe(false);
    const attempts = fetchMock.mock.calls.length;
    await expect(scheduleStaleChunkReload({ buildId: "build-a", storage, reload })).resolves.toBe(
      false,
    );
    expect(fetchMock).toHaveBeenCalledTimes(attempts);

    await vi.advanceTimersByTimeAsync(5_000);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(scheduleStaleChunkReload({ buildId: "build-a", storage, reload })).resolves.toBe(
      true,
    );
    expect(reload).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledTimes(attempts + 1);
  });

  it("probes a newer build immediately after an older build exhausted recovery", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const storage = memoryStorage();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const older = scheduleStaleChunkReload({ buildId: "build-a", storage, reload });
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(older).resolves.toBe(false);
    const attempts = fetchMock.mock.calls.length;
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    await expect(scheduleStaleChunkReload({ buildId: "build-b", storage, reload })).resolves.toBe(
      true,
    );
    expect(fetchMock).toHaveBeenCalledTimes(attempts + 1);
    expect(reload).toHaveBeenCalledOnce();
    expect(storage.getItem(GUARD_KEY)).toBe("build-b");
  });

  it("does not let an unrelated pending probe bypass a failed build's cooldown", async () => {
    vi.useFakeTimers();
    const pending = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const storage = memoryStorage();
    const reload = vi.fn();
    const attempt = (buildId: string) => scheduleStaleChunkReload({ buildId, storage, reload });
    const older = attempt("build-a");
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(older).resolves.toBe(false);
    const attempts = fetchMock.mock.calls.length;
    fetchMock.mockImplementationOnce(() => pending.promise);
    const newer = attempt("build-b");
    await expect(attempt("build-a")).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(attempts + 1);

    pending.resolve(new Response(null, { status: 503 }));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(newer).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(GUARD_KEY)).toBeNull();
  });

  it.each([false, true])(
    "reprobes a newer build after its joined older-build probe fails (replacement: %s)",
    async (replaceOwner) => {
      vi.useFakeTimers();
      const olderProbe = deferred<Response>();
      const fetchMock = vi
        .fn<typeof fetch>()
        .mockImplementationOnce(async () => olderProbe.promise)
        .mockResolvedValueOnce(new Response(null, { status: 200 }));
      vi.stubGlobal("fetch", fetchMock);
      const reload = vi.fn();
      const storage = memoryStorage();

      const olderBuild = scheduleStaleChunkReload({
        now: () => 1000,
        buildId: "build-a",
        storage,
        reload,
      });
      let ownsNewerBuild = true;
      const newerBuild = scheduleStaleChunkReload({
        now: () => 2000,
        buildId: "build-b",
        storage,
        reload,
        canReload: () => ownsNewerBuild,
      });
      const results = [olderBuild, newerBuild];
      if (replaceOwner) {
        ownsNewerBuild = false;
        results.push(
          scheduleStaleChunkReload({ now: () => 2000, buildId: "build-b", storage, reload }),
        );
      }
      expect(fetchMock).toHaveBeenCalledTimes(1);

      olderProbe.resolve(new Response(null, { status: 503 }));
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(Promise.all(results)).resolves.toEqual(
        replaceOwner ? [false, false, true] : [false, true],
      );

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(reload).toHaveBeenCalledTimes(1);
      expect(storage.getItem(GUARD_KEY)).toBe("build-b");
    },
  );

  it("reloads only the newest build after a shared document probe succeeds", async () => {
    const sharedProbe = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>(async () => sharedProbe.promise);
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    const storage = memoryStorage();

    const olderBuild = scheduleStaleChunkReload({
      now: () => 1000,
      buildId: "build-a",
      storage,
      reload,
    });
    const newerBuild = scheduleStaleChunkReload({
      now: () => 2000,
      buildId: "build-b",
      storage,
      reload,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sharedProbe.resolve(new Response(null, { status: 200 }));
    await expect(Promise.all([olderBuild, newerBuild])).resolves.toEqual([false, true]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe("build-b");
  });

  it("keeps target state isolated by storage while sharing document probes", async () => {
    vi.useFakeTimers();
    const sharedProbe = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>(async () => sharedProbe.promise);
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    const firstStorage = memoryStorage();
    const secondStorage = memoryStorage();

    const first = scheduleStaleChunkReload({
      now: () => 1000,
      buildId: "first-build",
      storage: firstStorage,
      reload,
    });
    const second = scheduleStaleChunkReload({
      now: () => 1000,
      buildId: "second-build",
      storage: secondStorage,
      reload,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    sharedProbe.resolve(new Response(null, { status: 503 }));
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(Promise.all([first, second])).resolves.toEqual([false, false]);
    await expect(
      retryStaleChunkReloadWhenReachable({
        reload,
        storage: firstStorage,
        timeoutMs: 0,
        probe: async () => true,
      }),
    ).resolves.toBe(true);
    expect(firstStorage.getItem(GUARD_KEY)).toBe("first-build");
    expect(secondStorage.getItem(GUARD_KEY)).toBeNull();
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("preserves the automatic target when a manual retry joins its probe", async () => {
    const sharedProbe = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => sharedProbe.promise),
    );
    const reload = vi.fn();
    const storage = memoryStorage({ [GUARD_KEY]: "displayed-build" });

    const automatic = scheduleStaleChunkReload({
      now: () => 1000,
      buildId: "target-build",
      storage,
      reload: () => reload("automatic"),
    });
    const manual = retryStaleChunkReloadWhenReachable({
      reload: () => reload("manual"),
      storage,
      timeoutMs: 0,
    });
    sharedProbe.resolve(new Response(null, { status: 200 }));

    await expect(Promise.all([automatic, manual])).resolves.toEqual([true, false]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe("target-build");
  });

  it("preserves the automatic target when it joins a manual probe", async () => {
    const sharedProbe = deferred<Response>();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => sharedProbe.promise),
    );
    const reload = vi.fn();
    const storage = memoryStorage({ [GUARD_KEY]: "displayed-build" });

    const manual = retryStaleChunkReloadWhenReachable({
      reload: () => reload("manual"),
      storage,
      timeoutMs: 0,
    });
    const automatic = scheduleStaleChunkReload({
      now: () => 1000,
      buildId: "target-build",
      storage,
      reload: () => reload("automatic"),
    });
    sharedProbe.resolve(new Response(null, { status: 200 }));

    await expect(Promise.all([manual, automatic])).resolves.toEqual([true, false]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe("target-build");
    await expect(
      retryStaleChunkReloadWhenReachable({
        reload: () => reload("later"),
        storage,
        timeoutMs: 0,
        probe: async () => true,
      }),
    ).resolves.toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("settles and aborts a hanging document probe after its deadline", async () => {
    vi.useFakeTimers();
    const reload = vi.fn();
    const fetchMock = stubHangingDocumentFetch();
    const retry = retryStaleChunkReloadWhenReachable({ reload, timeoutMs: 0 });

    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.signal).toBeInstanceOf(AbortSignal);

    const result = expect(retry).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);
    await result;

    expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(reload).not.toHaveBeenCalled();
  });

  it("coalesces automatic and manual probes while automatic recovery waits out failure", async () => {
    vi.useFakeTimers();
    const firstProbe = deferred<Response>();
    const fetchMock = vi.fn<typeof fetch>().mockImplementationOnce(async () => firstProbe.promise);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const reload = vi.fn();
    const storage = memoryStorage();

    const automatic = scheduleStaleChunkReload({ buildId: "gateway-target", storage, reload });
    const manual = retryStaleChunkReloadWhenReachable({ reload, storage, timeoutMs: 0 });
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    firstProbe.resolve(new Response(null, { status: 503 }));
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(Promise.all([automatic, manual])).resolves.toEqual([true, false]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("retryStaleChunkReloadWhenReachable single-shot", () => {
  it("rearms bounded automatic recovery when the gateway is reachable", async () => {
    const reload = vi.fn();
    const storage = memoryStorage({ [GUARD_KEY]: "replacement-build" });
    stubDocumentFetch(new Response(null, { status: 200 }));
    await expect(
      retryStaleChunkReloadWhenReachable({ reload, storage, timeoutMs: 0 }),
    ).resolves.toBe(true);
    expect(storage.getItem(GUARD_KEY)).toBe(CONTROL_UI_BUILD_INFO.buildId);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload while the gateway is unreachable", async () => {
    const reload = vi.fn();
    const storage = memoryStorage({ [GUARD_KEY]: "replacement-build" });
    stubDocumentFetch(new Response(null, { status: 503 }));
    await expect(
      retryStaleChunkReloadWhenReachable({ reload, storage, timeoutMs: 0 }),
    ).resolves.toBe(false);
    expect(storage.getItem(GUARD_KEY)).toBe("replacement-build");
    expect(reload).not.toHaveBeenCalled();
  });
});

describe("retryStaleChunkReloadWhenReachable", () => {
  it.each(["before", "during"] as const)(
    "does not reload when recovery is retired %s the document probe",
    async (retirement) => {
      const response = deferred<boolean>();
      const probe = vi.fn(() => response.promise);
      const reload = vi.fn();
      let current = retirement === "during";
      const pending = retryStaleChunkReloadWhenReachable({
        canReload: () => current,
        probe,
        reload,
      });

      current = false;
      response.resolve(true);

      await expect(pending).resolves.toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(probe).toHaveBeenCalledTimes(retirement === "during" ? 1 : 0);
    },
  );

  it("reloads immediately when the gateway already answers", async () => {
    const reload = vi.fn();
    const probe = vi.fn().mockResolvedValue(true);
    await expect(
      retryStaleChunkReloadWhenReachable({ reload, probe, storage: memoryStorage() }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it("admits one reload when retries complete together", async () => {
    const reachable = deferred<boolean>();
    const reload = vi.fn();
    const storage = memoryStorage({ [GUARD_KEY]: "replacement-build" });
    const probe = vi.fn(() => reachable.promise);
    const retries = [
      retryStaleChunkReloadWhenReachable({ reload, storage, probe }),
      retryStaleChunkReloadWhenReachable({ reload, storage, probe }),
    ];

    reachable.resolve(true);

    await expect(Promise.all(retries)).resolves.toEqual([true, false]);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe(CONTROL_UI_BUILD_INFO.buildId);
  });

  it("waits out a restarting gateway and then reloads", async () => {
    // The stale chunk exists because the gateway just restarted, so the first
    // probes legitimately fail; declining here is what stranded the user.
    const reload = vi.fn();
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    const wait = vi.fn().mockResolvedValue(undefined);
    await expect(
      retryStaleChunkReloadWhenReachable({
        reload,
        probe,
        wait,
        intervalMs: 5,
        storage: memoryStorage(),
      }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(probe).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("gives up at the deadline without navigating into an error page", async () => {
    const reload = vi.fn();
    const probe = vi.fn().mockResolvedValue(false);
    const wait = vi.fn().mockResolvedValue(undefined);
    let clock = 0;
    const now = () => {
      clock += 400;
      return clock;
    };
    await expect(
      retryStaleChunkReloadWhenReachable({ reload, probe, wait, now, timeoutMs: 1_000 }),
    ).resolves.toBe(false);
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
    const translate = vi.spyOn(i18n, "t").mockImplementation((key) => {
      if (key === "lazyView.stylesFailed") {
        return "Localized stylesheet failure";
      }
      if (key === "common.reload") {
        return "Localized reload";
      }
      return key;
    });
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
      expect(banner?.textContent).toContain("Localized stylesheet failure");
      expect(reloadButton?.textContent).toBe("Localized reload");
      expect(translate).toHaveBeenCalledWith("lazyView.stylesFailed", undefined);
      expect(translate).toHaveBeenCalledWith("common.reload", undefined);
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

describe("retryStaleChunkReloadWhenReachable deadline enforcement", () => {
  it("resolves at the deadline even when the probe never settles", async () => {
    vi.useFakeTimers();
    try {
      const reload = vi.fn();
      // A caller-supplied probe need not time out itself; the bound must still
      // hold or the pending UI would be stranded forever.
      const probe = vi.fn(() => new Promise<boolean>(() => {}));
      const pending = retryStaleChunkReloadWhenReachable({
        reload,
        probe,
        timeoutMs: 5_000,
      });
      await vi.advanceTimersByTimeAsync(6_000);
      await expect(pending).resolves.toBe(false);
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

it("never starts an unbounded probe once the wait carried past the deadline", async () => {
  const reload = vi.fn();
  let calls = 0;
  // A second probe would hang forever; the loop must not start one, or the
  // caller's disabled Reload button would be stranded past its own bound.
  const probe = vi.fn(async () => {
    calls += 1;
    return calls === 1 ? false : new Promise<boolean>(() => {});
  });
  let clock = 0;
  const wait = vi.fn(async () => {
    clock += 10_000;
  });

  await expect(
    retryStaleChunkReloadWhenReachable({
      reload,
      probe,
      wait,
      now: () => clock,
      timeoutMs: 5_000,
    }),
  ).resolves.toBe(false);
  expect(probe).toHaveBeenCalledTimes(1);
  expect(reload).not.toHaveBeenCalled();
});

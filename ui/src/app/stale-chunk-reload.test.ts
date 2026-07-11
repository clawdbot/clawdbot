import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installStaleChunkReloadListener,
  isStaleChunkImportError,
  resetStaleChunkReloadStateForTest,
  retryStaleChunkReload,
  scheduleStaleChunkReload,
} from "./stale-chunk-reload.ts";

const GUARD_KEY = "openclaw.controlUi.staleChunkReloadBuildId";

function memoryStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => void store.set(key, value),
  };
}

afterEach(() => {
  resetStaleChunkReloadStateForTest();
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
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        buildId: "build-a",
        storage,
        probeDocument: async () => true,
        reload,
      }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe("build-a");
  });

  it("never auto-reloads twice for the same build, but recovers on a newer build", async () => {
    const reload = vi.fn();
    const storage = memoryStorage({ [GUARD_KEY]: "build-a" });
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        buildId: "build-a",
        storage,
        probeDocument: async () => true,
        reload,
      }),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    resetStaleChunkReloadStateForTest();
    await expect(
      scheduleStaleChunkReload({
        now: () => 2000,
        buildId: "build-b",
        storage,
        probeDocument: async () => true,
        reload,
      }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(storage.getItem(GUARD_KEY)).toBe("build-b");
  });

  it("does not reload or set the guard while the gateway is unreachable", async () => {
    const reload = vi.fn();
    const storage = memoryStorage();
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        storage,
        probeDocument: async () => false,
        reload,
      }),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(storage.getItem(GUARD_KEY)).toBeNull();
  });

  it("does not auto-reload when the guard cannot be persisted", async () => {
    const reload = vi.fn();
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        storage: null,
        probeDocument: async () => true,
        reload,
      }),
    ).resolves.toBe(false);
    resetStaleChunkReloadStateForTest();
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        storage: {
          getItem: () => null,
          setItem: () => {
            throw new Error("quota exceeded");
          },
        },
        probeDocument: async () => true,
        reload,
      }),
    ).resolves.toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });

  it("applies an in-memory cooldown between attempts", async () => {
    const reload = vi.fn();
    const probeDocument = vi.fn(async () => true);
    const storage = memoryStorage();
    await expect(
      scheduleStaleChunkReload({
        now: () => 1000,
        storage,
        probeDocument: async () => false,
        reload,
      }),
    ).resolves.toBe(false);
    await expect(
      scheduleStaleChunkReload({ now: () => 2000, storage, probeDocument, reload }),
    ).resolves.toBe(false);
    expect(probeDocument).not.toHaveBeenCalled();
    await expect(
      scheduleStaleChunkReload({ now: () => 7000, storage, probeDocument, reload }),
    ).resolves.toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });
});

describe("retryStaleChunkReload", () => {
  it("reloads without the rate guard when the gateway is reachable", async () => {
    const reload = vi.fn();
    await expect(retryStaleChunkReload({ probeDocument: async () => true, reload })).resolves.toBe(
      true,
    );
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it("does not reload while the gateway is unreachable", async () => {
    const reload = vi.fn();
    await expect(retryStaleChunkReload({ probeDocument: async () => false, reload })).resolves.toBe(
      false,
    );
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

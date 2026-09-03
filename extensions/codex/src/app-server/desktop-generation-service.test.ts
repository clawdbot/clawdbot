import { EventEmitter } from "node:events";
import type { FSWatcher } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createCodexDesktopGenerationService,
  waitForCodexDesktopGeneration,
} from "./desktop-generation.js";

class FakeWatcher extends EventEmitter {
  close = vi.fn();
  ref = vi.fn(() => this);
  unref = vi.fn(() => this);
}

type WatchRegistration = {
  watchedPath: string;
  recursive: boolean;
  listener: (eventType: string, filename: string | Buffer | null) => void;
  watcher: FakeWatcher;
};

function createHarness(initialFingerprint: string) {
  let fingerprint = initialFingerprint;
  const registrations: WatchRegistration[] = [];
  const readFingerprint = vi.fn(async () => fingerprint);
  const onGenerationChange = vi.fn();
  const clearFailure = vi.fn();
  const reportFailure = vi.fn();
  const warn = vi.fn();
  const service = createCodexDesktopGenerationService(
    { onGenerationChange },
    {
      platform: "darwin",
      readFingerprint,
      resolveWatchPaths: () => ["/Applications", "/Applications/ChatGPT.app"],
      pathExists: () => true,
      watchPath: (watchedPath, options, listener) => {
        const watcher = new FakeWatcher();
        registrations.push({ watchedPath, recursive: options.recursive, listener, watcher });
        return watcher as FSWatcher;
      },
    },
  );
  return {
    service,
    registrations,
    readFingerprint,
    onGenerationChange,
    clearFailure,
    reportFailure,
    warn,
    setFingerprint: (next: string) => {
      fingerprint = next;
    },
  };
}

async function startAndSettle(harness: ReturnType<typeof createHarness>): Promise<void> {
  await harness.service.start?.({
    logger: { warn: harness.warn },
    serviceHealth: {
      clearFailure: harness.clearFailure,
      reportFailure: harness.reportFailure,
    },
  } as never);
  await vi.waitFor(() => expect(harness.readFingerprint).toHaveBeenCalledOnce());
  await vi.advanceTimersByTimeAsync(1_000);
  await vi.waitFor(() => expect(harness.readFingerprint).toHaveBeenCalledTimes(2));
}

describe("Codex desktop generation service", () => {
  let service: ReturnType<typeof createCodexDesktopGenerationService> | undefined;

  afterEach(async () => {
    await service?.stop?.({} as never);
    service = undefined;
    vi.useRealTimers();
  });

  it("starts without blocking on initial convergence", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-start");
    service = harness.service;

    await service.start?.({
      logger: { warn: harness.warn },
      serviceHealth: {
        clearFailure: harness.clearFailure,
        reportFailure: harness.reportFailure,
      },
    } as never);

    expect(harness.registrations).toHaveLength(2);
    expect(
      harness.registrations.map(({ watchedPath, recursive }) => [watchedPath, recursive]),
    ).toEqual([
      ["/Applications", false],
      ["/Applications/ChatGPT.app", true],
    ]);
    expect(harness.clearFailure).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.clearFailure).toHaveBeenCalledOnce());
  });

  it("rearms stable directory watches and publishes a settled root replacement", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-x");
    service = harness.service;
    await startAndSettle(harness);
    harness.onGenerationChange.mockClear();
    harness.clearFailure.mockClear();
    const oldArm = [...harness.registrations];
    const applications = oldArm.find((entry) => entry.watchedPath === "/Applications");
    expect(applications).toBeDefined();

    harness.setFingerprint("desktop-y");
    applications?.listener("rename", "ChatGPT.app");
    await vi.advanceTimersByTimeAsync(100);
    expect(oldArm.every((entry) => entry.watcher.close.mock.calls.length === 1)).toBe(true);
    expect(harness.registrations).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.onGenerationChange).toHaveBeenCalledOnce());
    expect(harness.onGenerationChange).toHaveBeenCalledWith({
      epoch: expect.any(Number),
      fingerprint: "desktop-y",
    });

    applications?.listener("rename", "ChatGPT.app");
    oldArm[0]?.watcher.emit("error", new Error("stale watcher"));
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(4);
    expect(harness.reportFailure).not.toHaveBeenCalled();
  });

  it("ignores unrelated application events and recovers a watcher error", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-errors");
    service = harness.service;
    await startAndSettle(harness);
    const oldArm = [...harness.registrations];
    const applications = oldArm.find((entry) => entry.watchedPath === "/Applications");

    applications?.listener("rename", "Safari.app");
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(2);

    oldArm[0]?.watcher.emit("error", new Error("watch lost"));
    expect(harness.reportFailure).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(harness.registrations).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(() => expect(harness.clearFailure).toHaveBeenCalledTimes(2));
  });

  it("settles the current generation while persistent watcher registration retries", async () => {
    vi.useFakeTimers();
    let fingerprint = "desktop-stable";
    const readFingerprint = vi.fn(async () => fingerprint);
    const onGenerationChange = vi.fn();
    const clearFailure = vi.fn();
    const reportFailure = vi.fn();
    const warn = vi.fn();
    const watchPath = vi.fn(
      (
        _watchedPath: string,
        _options: { recursive: boolean },
        _listener: (eventType: string, filename: string | Buffer | null) => void,
      ): FSWatcher => {
        throw new Error("watch unavailable");
      },
    );
    service = createCodexDesktopGenerationService(
      { onGenerationChange },
      {
        platform: "darwin",
        readFingerprint,
        resolveWatchPaths: () => ["/Applications"],
        pathExists: () => true,
        watchPath,
      },
    );
    await service.start?.({
      logger: { warn },
      serviceHealth: { clearFailure, reportFailure },
    } as never);
    let settled = false;
    void waitForCodexDesktopGeneration().then(() => {
      settled = true;
    });

    await vi.advanceTimersByTimeAsync(5_000);

    expect(settled).toBe(true);
    fingerprint = "desktop-updated";
    await vi.advanceTimersByTimeAsync(60_000);

    expect(watchPath.mock.calls.length).toBeGreaterThan(2);
    expect(watchPath.mock.calls.length).toBeLessThan(20);
    expect(readFingerprint.mock.calls.length).toBeGreaterThan(2);
    expect(onGenerationChange).toHaveBeenCalledWith({
      epoch: expect.any(Number),
      fingerprint: "desktop-updated",
    });
    expect(reportFailure).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
    expect(clearFailure).not.toHaveBeenCalled();
  });

  it("does not publish a generation after service stop during settling", async () => {
    vi.useFakeTimers();
    const harness = createHarness("desktop-stop");
    service = harness.service;
    await service.start?.({
      logger: { warn: harness.warn },
      serviceHealth: {
        clearFailure: harness.clearFailure,
        reportFailure: harness.reportFailure,
      },
    } as never);
    await vi.waitFor(() => expect(harness.readFingerprint).toHaveBeenCalledOnce());

    await service.stop?.({} as never);
    service = undefined;
    harness.setFingerprint("desktop-after-stop");
    await vi.advanceTimersByTimeAsync(1_000);

    expect(harness.onGenerationChange).not.toHaveBeenCalled();
    expect(harness.readFingerprint).toHaveBeenCalledOnce();
  });
});

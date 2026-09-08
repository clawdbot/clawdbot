import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { drainGlobalSingletonLifecycleState } from "../shared/global-singleton.js";
import { cleanupTalkConnection, registerTalkConnectionCleanup } from "./talk-session-registry.js";

describe("Talk connection cleanup registry", () => {
  it("keeps one cleanup per relay kind and fences reentrant cleanup", () => {
    const replacedRealtimeCleanup = vi.fn();
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };
    const realtimeCleanup = vi.fn(() => {
      cleanupTalkConnection("conn-dedupe", log);
    });

    registerTalkConnectionCleanup("conn-dedupe", "realtime-relay", replacedRealtimeCleanup);
    registerTalkConnectionCleanup("conn-dedupe", "realtime-relay", realtimeCleanup);
    registerTalkConnectionCleanup("conn-dedupe", "transcription-relay", transcriptionCleanup);

    cleanupTalkConnection("conn-dedupe", log);
    cleanupTalkConnection("conn-dedupe", log);

    expect(replacedRealtimeCleanup).not.toHaveBeenCalled();
    expect(realtimeCleanup).toHaveBeenCalledOnce();
    expect(realtimeCleanup.mock.contexts).toEqual([undefined]);
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("continues cleanup after one relay owner throws", () => {
    const cleanupError = new Error("realtime cleanup failed");
    const transcriptionCleanup = vi.fn();
    const log = { warn: vi.fn() };

    registerTalkConnectionCleanup(
      "conn-error",
      "realtime-relay",
      vi.fn().mockImplementationOnce(() => {
        throw cleanupError;
      }),
    );
    registerTalkConnectionCleanup("conn-error", "transcription-relay", transcriptionCleanup);

    cleanupTalkConnection("conn-error", log);

    expect(log.warn).toHaveBeenCalledWith(
      "failed to run realtime-relay Talk cleanup after connection disconnect: realtime cleanup failed",
    );
    expect(transcriptionCleanup).toHaveBeenCalledOnce();
    cleanupTalkConnection("conn-error", log);
  });

  it("retains failed async cleanup for shutdown retry without replacing its owner", async () => {
    const first = createDeferred();
    const finish = createDeferred();
    const log = { warn: vi.fn() };
    const queued = createDeferred();
    const queuedStarted = createDeferred();
    const replacement = vi.fn(() => {
      queuedStarted.resolve();
      return queued.promise;
    });
    const cleanup = vi
      .fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => finish.promise);
    registerTalkConnectionCleanup("conn-async-retry", "browser-control", cleanup);
    cleanupTalkConnection("conn-async-retry", log);
    cleanupTalkConnection("conn-async-retry", log);
    expect(cleanup).toHaveBeenCalledOnce();
    const firstObserved = first.promise.catch(() => undefined);
    first.reject(new Error("physical cleanup failed"));
    await firstObserved;
    await Promise.resolve();
    registerTalkConnectionCleanup("conn-async-retry", "browser-control", replacement);
    let drained = false;
    const draining = drainGlobalSingletonLifecycleState("restart").then(() => {
      drained = true;
    });
    let concurrentDrained = false;
    const concurrentDrain = drainGlobalSingletonLifecycleState("restart").then(() => {
      concurrentDrained = true;
    });
    try {
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(replacement).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(drained).toBe(false);
      finish.resolve();
      await queuedStarted.promise;
      expect(drained).toBe(false);
      expect(concurrentDrained).toBe(false);
      expect(replacement).toHaveBeenCalledOnce();
      queued.resolve();
      await Promise.all([draining, concurrentDrain]);
      cleanupTalkConnection("conn-async-retry", log);
      expect(cleanup).toHaveBeenCalledTimes(2);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("physical cleanup failed"));
    } finally {
      finish.resolve();
      queued.resolve();
      await Promise.all([draining, concurrentDrain]);
    }
  });

  it("joins a restart drain started before the cleanup callback returns", async () => {
    const finish = createDeferred();
    let drained = false;
    let draining = Promise.resolve();
    registerTalkConnectionCleanup("conn-reentrant-drain", "browser-control", () => {
      draining = drainGlobalSingletonLifecycleState("restart").then(() => {
        drained = true;
      });
      return finish.promise;
    });
    cleanupTalkConnection("conn-reentrant-drain", { warn: vi.fn() });
    try {
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });
      expect(drained).toBe(false);
    } finally {
      finish.resolve();
      await draining;
    }
    expect(drained).toBe(true);
  });
});

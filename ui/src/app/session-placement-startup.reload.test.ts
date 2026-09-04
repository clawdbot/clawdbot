import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  createPlacementStartupHarness,
  flushStartupMicrotasks,
} from "./session-placement-startup.test-support.ts";
import * as chunkRecovery from "./stale-chunk-reload.ts";

beforeEach(() => sessionStorage.clear());
afterEach(() => vi.restoreAllMocks());

it.each(["credentials", "disposal", "memory-only"])(
  "does not reload a restored startup after %s custody prevents it",
  async (change) => {
    const reload = vi
      .spyOn(chunkRecovery, "retryStaleChunkReloadWhenReachable")
      .mockResolvedValue(false);
    const loadRuntime = vi.fn(() =>
      Promise.reject(
        new Error("Failed to fetch dynamically imported module: /assets/startup-runtime.js"),
      ),
    );
    const { startup, input, gateway } = createPlacementStartupHarness(vi.fn(), { loadRuntime });
    startup.resumeRecovery();
    if (change === "memory-only") {
      startup.start({
        ...input,
        persistRecovery: false,
        recovery: { ...input.recovery, sessionKey: "agent:cloud:incognito" },
      });
    }
    await flushStartupMicrotasks();
    startup.retry(input.recovery.sessionKey);
    expect(reload).toHaveBeenCalledOnce();
    const canReload = reload.mock.calls[0]?.[0]?.canReload;
    expect(canReload?.()).toBe(change !== "memory-only");
    if (change === "credentials") {
      Object.assign(gateway, { connectionRevision: 1 });
    } else if (change === "disposal") {
      startup.dispose();
    }
    expect(canReload?.()).toBe(false);
    expect(loadRuntime).toHaveBeenCalledOnce();
    startup.dispose();
  },
);

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PLUGIN_HOST_CLEANUP_TIMEOUT_MS,
  withPluginHostCleanupTimeout,
} from "./host-hook-cleanup-timeout.js";

describe("withPluginHostCleanupTimeout", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("unrefs cleanup timeout timers so pending cleanup does not keep the process alive", async () => {
    const originalSetTimeout = globalThis.setTimeout;
    const unref = vi.fn();

    vi.spyOn(globalThis, "setTimeout").mockImplementation(((
      callback: () => void,
      timeout?: number,
    ) => {
      const timer = originalSetTimeout(callback, timeout);
      vi.spyOn(timer, "unref").mockImplementation(() => {
        unref();
        return timer;
      });
      return timer;
    }) as typeof setTimeout);

    await expect(withPluginHostCleanupTimeout("fast-cleanup", () => "ok")).resolves.toBe("ok");

    expect(globalThis.setTimeout).toHaveBeenCalledWith(
      expect.any(Function),
      PLUGIN_HOST_CLEANUP_TIMEOUT_MS,
    );
    expect(unref).toHaveBeenCalledTimes(1);
  });
});

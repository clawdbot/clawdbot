/** Verifies host hook cleanup timeout behavior and cancellation reporting. */
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withPluginHostCleanupTimeout } from "./host-hook-cleanup-timeout.js";

const PLUGIN_HOST_CLEANUP_TIMEOUT_MS = 5_000;

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

    const timeoutCall = expectDefined(
      vi.mocked(globalThis.setTimeout).mock.calls[0],
      "setTimeout call 0",
    );
    expect(typeof timeoutCall[0]).toBe("function");
    expect(timeoutCall[1]).toBe(PLUGIN_HOST_CLEANUP_TIMEOUT_MS);
    expect(unref).toHaveBeenCalledTimes(1);
  });
});

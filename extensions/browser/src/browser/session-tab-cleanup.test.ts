// Browser tests cover periodic session-tab cleanup failure handling.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const registryMocks = vi.hoisted(() => ({
  sweepTrackedBrowserTabs: vi.fn(),
}));

vi.mock("./session-tab-registry.js", () => registryMocks);

import { startTrackedBrowserTabCleanupTimer } from "./session-tab-cleanup.js";

describe("session tab cleanup timer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    registryMocks.sweepTrackedBrowserTabs.mockReset();
    clearRuntimeConfigSnapshot();
    const config = {
      browser: {
        tabCleanup: {
          enabled: true,
        },
      },
    };
    setRuntimeConfigSnapshot(config, config);
  });

  afterEach(() => {
    clearRuntimeConfigSnapshot();
    vi.useRealTimers();
  });

  it("warns on sweep store failures and continues scheduling", async () => {
    registryMocks.sweepTrackedBrowserTabs
      .mockRejectedValueOnce(new Error("sqlite read failed"))
      .mockResolvedValueOnce(0);
    const onWarn = vi.fn();
    const stop = startTrackedBrowserTabCleanupTimer({ onWarn });

    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(() =>
      expect(onWarn).toHaveBeenCalledWith(
        "failed to sweep tracked browser tabs: Error: sqlite read failed",
      ),
    );
    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(() => expect(registryMocks.sweepTrackedBrowserTabs).toHaveBeenCalledTimes(2));

    await stop();
  });

  it("adopts cleanup policy changes without replacing the timer", async () => {
    registryMocks.sweepTrackedBrowserTabs.mockResolvedValue(0);
    const resolved = { profiles: {} } as never;
    const getResolvedBrowserConfig = vi.fn(() => resolved);
    const stop = startTrackedBrowserTabCleanupTimer({
      getResolvedBrowserConfig,
      onWarn: vi.fn(),
    });

    await vi.advanceTimersByTimeAsync(300_000);
    await vi.waitFor(() => expect(registryMocks.sweepTrackedBrowserTabs).toHaveBeenCalledOnce());
    expect(registryMocks.sweepTrackedBrowserTabs).toHaveBeenCalledWith(
      expect.objectContaining({ getResolvedBrowserConfig }),
    );

    const disabled = { browser: { tabCleanup: { enabled: false } } };
    setRuntimeConfigSnapshot(disabled, disabled);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(registryMocks.sweepTrackedBrowserTabs).toHaveBeenCalledTimes(1);

    const enabled = { browser: { tabCleanup: { enabled: true } } };
    setRuntimeConfigSnapshot(enabled, enabled);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(registryMocks.sweepTrackedBrowserTabs).toHaveBeenCalledTimes(2);
    await stop();
  });

  it("waits for the active sweep and does not reschedule after stop", async () => {
    const sweep = createDeferred<number>();
    registryMocks.sweepTrackedBrowserTabs.mockReturnValue(sweep.promise);
    const stop = startTrackedBrowserTabCleanupTimer({ onWarn: vi.fn() });
    await vi.advanceTimersByTimeAsync(300_000);
    expect(registryMocks.sweepTrackedBrowserTabs).toHaveBeenCalledOnce();

    const stopped = vi.fn();
    const stopping = stop().then(stopped);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(stopped).not.toHaveBeenCalled();
    expect(registryMocks.sweepTrackedBrowserTabs).toHaveBeenCalledOnce();

    sweep.resolve(0);
    await stopping;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(stopped).toHaveBeenCalledOnce();
    expect(registryMocks.sweepTrackedBrowserTabs).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});

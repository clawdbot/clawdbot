// Browser tests cover periodic session-tab cleanup failure handling.
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
          idleMinutes: 30,
          maxTabsPerSession: 10,
          sweepMinutes: 1,
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
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPrimaryTrackedBrowserSessionKey,
  runTrackedBrowserTabCleanupOnce,
} from "./session-tab-cleanup.js";
import {
  __countTrackedSessionBrowserTabsForTests,
  __resetTrackedSessionBrowserTabsForTests,
  trackSessionBrowserTab,
} from "./session-tab-registry.js";

describe("session tab cleanup", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetTrackedSessionBrowserTabsForTests();
  });

  afterEach(() => {
    __resetTrackedSessionBrowserTabsForTests();
    vi.useRealTimers();
  });

  it("classifies primary sessions without matching subagent, cron, or acp sessions", () => {
    expect(isPrimaryTrackedBrowserSessionKey("agent:main:main")).toBe(true);
    expect(isPrimaryTrackedBrowserSessionKey("agent:main:subagent:child")).toBe(false);
    expect(isPrimaryTrackedBrowserSessionKey("agent:main:cron:nightly")).toBe(false);
    expect(isPrimaryTrackedBrowserSessionKey("agent:main:acp:child")).toBe(false);
  });

  it("only cleans up tracked tabs for primary-agent sessions", async () => {
    vi.setSystemTime(1_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "primary-tab" });
    trackSessionBrowserTab({ sessionKey: "agent:main:subagent:child", targetId: "child-tab" });
    trackSessionBrowserTab({ sessionKey: "agent:main:cron:nightly", targetId: "cron-tab" });

    const closed = await runTrackedBrowserTabCleanupOnce({
      now: 10_000,
      closeTab: vi.fn(async () => {}),
      cleanup: {
        enabled: true,
        idleMinutes: 0.001,
        maxTabsPerSession: 8,
        sweepMinutes: 5,
      },
    });

    expect(closed).toBe(1);
    expect(__countTrackedSessionBrowserTabsForTests("agent:main:main")).toBe(0);
    expect(__countTrackedSessionBrowserTabsForTests("agent:main:subagent:child")).toBe(1);
    expect(__countTrackedSessionBrowserTabsForTests("agent:main:cron:nightly")).toBe(1);
  });
});

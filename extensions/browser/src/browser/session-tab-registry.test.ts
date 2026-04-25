import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __countTrackedSessionBrowserTabsForTests,
  __resetTrackedSessionBrowserTabsForTests,
  closeTrackedBrowserTabsForSessions,
  sweepTrackedBrowserTabs,
  touchSessionBrowserTab,
  trackSessionBrowserTab,
  untrackSessionBrowserTab,
} from "./session-tab-registry.js";

describe("session tab registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetTrackedSessionBrowserTabsForTests();
  });

  afterEach(() => {
    __resetTrackedSessionBrowserTabsForTests();
    vi.useRealTimers();
  });

  it("tracks and closes tabs for normalized session keys", async () => {
    trackSessionBrowserTab({
      sessionKey: "Agent:Main:Main",
      targetId: "tab-a",
      baseUrl: "http://127.0.0.1:9222",
      profile: "OpenClaw",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-b",
      baseUrl: "http://127.0.0.1:9222",
      profile: "OpenClaw",
    });
    expect(__countTrackedSessionBrowserTabsForTests("agent:main:main")).toBe(2);

    const closeTab = vi.fn(async () => {});
    const closed = await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeTab,
    });

    expect(closed).toBe(2);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(closeTab).toHaveBeenNthCalledWith(1, {
      targetId: "tab-a",
      baseUrl: "http://127.0.0.1:9222",
      profile: "openclaw",
    });
    expect(closeTab).toHaveBeenNthCalledWith(2, {
      targetId: "tab-b",
      baseUrl: "http://127.0.0.1:9222",
      profile: "openclaw",
    });
    expect(__countTrackedSessionBrowserTabsForTests()).toBe(0);
  });

  it("untracks specific tabs", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-b",
    });
    untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });

    const closeTab = vi.fn(async () => {});
    const closed = await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeTab,
    });

    expect(closed).toBe(1);
    expect(closeTab).toHaveBeenCalledTimes(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "tab-b",
      baseUrl: undefined,
      profile: undefined,
    });
  });

  it("deduplicates tabs and ignores expected close errors", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "main",
      targetId: "tab-a",
    });
    trackSessionBrowserTab({
      sessionKey: "main",
      targetId: "tab-b",
    });
    const warnings: string[] = [];
    const closeTab = vi
      .fn()
      .mockRejectedValueOnce(new Error("target not found"))
      .mockRejectedValueOnce(new Error("network down"));

    const closed = await closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main", "main"],
      closeTab,
      onWarn: (message) => warnings.push(message),
    });

    expect(closed).toBe(0);
    expect(closeTab).toHaveBeenCalledTimes(2);
    expect(warnings).toEqual([expect.stringContaining("network down")]);
    expect(__countTrackedSessionBrowserTabsForTests()).toBe(0);
  });

  it("sweeps idle tracked tabs and keeps recently touched tabs", async () => {
    vi.setSystemTime(1_000);
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "old-tab",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "active-tab",
    });
    touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "active-tab",
      now: 11_000,
    });

    const closeTab = vi.fn(async () => {});
    const closed = await sweepTrackedBrowserTabs({
      now: 11_000,
      idleMs: 5_000,
      closeTab,
    });

    expect(closed).toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "old-tab",
      baseUrl: undefined,
      profile: undefined,
    });
    expect(__countTrackedSessionBrowserTabsForTests("agent:main:main")).toBe(1);
  });

  it("caps tracked tabs per session by closing least recently used tabs first", async () => {
    vi.setSystemTime(1_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-a" });
    vi.setSystemTime(2_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-b" });
    vi.setSystemTime(3_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-c" });

    const closeTab = vi.fn(async () => {});
    const closed = await sweepTrackedBrowserTabs({
      now: 4_000,
      maxTabsPerSession: 2,
      closeTab,
    });

    expect(closed).toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "tab-a",
      baseUrl: undefined,
      profile: undefined,
    });
    expect(__countTrackedSessionBrowserTabsForTests("agent:main:main")).toBe(2);
  });

  it("honors session filters during sweeps", async () => {
    vi.setSystemTime(1_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "primary-tab" });
    trackSessionBrowserTab({ sessionKey: "agent:main:subagent:child", targetId: "child-tab" });

    const closeTab = vi.fn(async () => {});
    const closed = await sweepTrackedBrowserTabs({
      now: 10_000,
      idleMs: 1,
      sessionFilter: (sessionKey) => !sessionKey.includes(":subagent:"),
      closeTab,
    });

    expect(closed).toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "primary-tab",
      baseUrl: undefined,
      profile: undefined,
    });
    expect(__countTrackedSessionBrowserTabsForTests()).toBe(1);
  });
});

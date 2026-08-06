// Browser tests cover process-local session tab cleanup behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  browserCloseTabByRawTargetId: vi.fn(async () => {}),
}));

vi.mock("./client.js", () => clientMocks);

import {
  closeTrackedBrowserTabsForSessions,
  sweepTrackedBrowserTabs,
  touchSessionBrowserTab,
  trackSessionBrowserTab as trackSessionBrowserTabRuntime,
  untrackSessionBrowserTab,
} from "./session-tab-registry.js";

const trackedSessionKeys = new Set<string>();

function trackSessionBrowserTab(params: Parameters<typeof trackSessionBrowserTabRuntime>[0]) {
  if (params.sessionKey) {
    trackedSessionKeys.add(params.sessionKey);
  }
  trackSessionBrowserTabRuntime(params);
}

describe("session tab registry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    clientMocks.browserCloseTabByRawTargetId.mockClear();
    trackedSessionKeys.clear();
  });

  afterEach(async () => {
    await closeTrackedBrowserTabsForSessions({
      sessionKeys: [...trackedSessionKeys],
      closeTab: async () => {},
    });
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
    const closeTab = vi.fn(async () => {});

    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(2);
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
  });

  it("closes tracked tabs through the raw target-id client path", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW_TARGET",
      baseUrl: "http://127.0.0.1:9222",
      profile: "OpenClaw",
    });

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"] }),
    ).resolves.toBe(1);
    expect(clientMocks.browserCloseTabByRawTargetId).toHaveBeenCalledWith(
      "http://127.0.0.1:9222",
      "RAW_TARGET",
      { profile: "openclaw" },
    );
  });

  it("untracks a specific tab and never adopts unknown user tabs", async () => {
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-a" });
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-b" });
    untrackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-a" });
    const closeTab = vi.fn(async () => {});

    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:unknown"],
        closeTab,
      }),
    ).resolves.toBe(0);
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "tab-b",
      baseUrl: undefined,
      profile: undefined,
    });
  });

  it("touches and untracks a volatile tab through same-process aliases", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-A",
      profile: "openclaw",
      ownership: { status: "non-durable", reason: "browser-identity-lookup-failed" },
      aliases: ["RAW-A", "t1", "docs"],
      now: 1_000,
    });
    touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "docs",
      profile: "openclaw",
      now: 9_000,
    });
    const closeTab = vi.fn(async () => {});

    await expect(sweepTrackedBrowserTabs({ now: 10_000, idleMs: 5_000, closeTab })).resolves.toBe(
      0,
    );
    untrackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "t1",
      profile: "openclaw",
    });
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab,
      }),
    ).resolves.toBe(0);
    expect(closeTab).not.toHaveBeenCalled();
  });

  it("isolates volatile aliases by browser surface", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-A",
      baseUrl: "http://127.0.0.1:9001",
      profile: "openclaw",
      aliases: ["shared"],
      now: 1_000,
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-B",
      baseUrl: "http://127.0.0.1:9002",
      profile: "openclaw",
      aliases: ["shared"],
      now: 1_000,
    });
    touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared",
      baseUrl: "http://127.0.0.1:9001",
      profile: "openclaw",
      now: 9_000,
    });
    const closeTab = vi.fn(async () => {});

    await expect(sweepTrackedBrowserTabs({ now: 10_000, idleMs: 5_000, closeTab })).resolves.toBe(
      1,
    );
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "RAW-B",
      baseUrl: "http://127.0.0.1:9002",
      profile: "openclaw",
    });
  });

  it("retries transient close failures and retires missing targets", async () => {
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "missing" });
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "transient" });
    const warnings: string[] = [];
    const firstClose = vi.fn(async ({ targetId }: { targetId: string }) => {
      if (targetId === "missing") {
        throw new Error("No target with given id found");
      }
      throw new Error("network down");
    });

    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab: firstClose,
        onWarn: (message) => warnings.push(message),
      }),
    ).resolves.toBe(0);
    expect(warnings).toEqual([
      "failed to close tracked browser tab transient: Error: network down",
    ]);

    const retryClose = vi.fn(async () => {});
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab: retryClose,
      }),
    ).resolves.toBe(1);
    expect(retryClose).toHaveBeenCalledWith({
      targetId: "transient",
      baseUrl: undefined,
      profile: undefined,
    });
  });

  it("sweeps idle tabs while preserving recently touched tabs", async () => {
    vi.setSystemTime(1_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "old-tab" });
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "active-tab" });
    touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "active-tab",
      now: 11_000,
    });
    const closeTab = vi.fn(async () => {});

    await expect(sweepTrackedBrowserTabs({ now: 11_000, idleMs: 5_000, closeTab })).resolves.toBe(
      1,
    );
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "old-tab",
      baseUrl: undefined,
      profile: undefined,
    });
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:main"],
        closeTab: async () => {},
      }),
    ).resolves.toBe(1);
  });

  it("caps each session by least-recently-used order and honors session filters", async () => {
    vi.setSystemTime(1_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-a" });
    vi.setSystemTime(2_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-b" });
    vi.setSystemTime(3_000);
    trackSessionBrowserTab({ sessionKey: "agent:main:main", targetId: "tab-c" });
    trackSessionBrowserTab({
      sessionKey: "agent:main:subagent:child",
      targetId: "child-tab",
    });
    const closeTab = vi.fn(async () => {});

    await expect(
      sweepTrackedBrowserTabs({
        now: 4_000,
        maxTabsPerSession: 2,
        sessionFilter: (sessionKey) => !sessionKey.includes(":subagent:"),
        closeTab,
      }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledWith({
      targetId: "tab-a",
      baseUrl: undefined,
      profile: undefined,
    });
    await expect(
      closeTrackedBrowserTabsForSessions({
        sessionKeys: ["agent:main:subagent:child"],
        closeTab: async () => {},
      }),
    ).resolves.toBe(1);
  });
});

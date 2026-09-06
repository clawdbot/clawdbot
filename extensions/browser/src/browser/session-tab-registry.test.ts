// Browser tests cover process-local session tab cleanup behavior.
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const clientMocks = vi.hoisted(() => ({
  browserCloseTabByRawTargetId: vi.fn(async () => {}),
  onLoad: undefined as (() => Promise<void>) | undefined,
}));

vi.mock("./client.js", async () => {
  await clientMocks.onLoad?.();
  return clientMocks;
});

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

  it("reserves cleanup while its client loads before an overlapping closer can fail", async () => {
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    clientMocks.onLoad = () => {
      entered.resolve();
      return release.promise;
    };
    const sessionKey = "agent:main:main";
    trackSessionBrowserTab({ sessionKey, targetId: "loading-client" });
    const onWarn = vi.fn();
    const closeTab = vi.fn<() => Promise<void>>(() => {
      throw new Error("close failed");
    });
    const pending = [closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], onWarn })];
    try {
      await entered.promise;
      pending.push(
        closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], closeTab, onWarn }),
      );
    } finally {
      release.resolve();
      clientMocks.onLoad = undefined;
    }
    await expect(Promise.all(pending)).resolves.toEqual([1, 0]);
    expect(clientMocks.browserCloseTabByRawTargetId).toHaveBeenCalledOnce();
    expect(closeTab).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it("tracks and closes tabs for normalized session keys", async () => {
    trackSessionBrowserTab({
      sessionKey: "Agent:Main:Main",
      targetId: "tab-a",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9222" },
      profile: "OpenClaw",
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "tab-b",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9222" },
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
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9222" },
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

  it("closes node-proxy tabs through their route-owned raw-target closer", async () => {
    const closeTarget = vi.fn(async () => ({ status: "closed" as const }));
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "NODE_TARGET",
      profile: "user",
      route: { kind: "node-proxy", nodeId: "node-1", closeTarget },
    });

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"] }),
    ).resolves.toBe(1);
    expect(closeTarget).toHaveBeenCalledWith({
      targetId: "NODE_TARGET",
      profile: "user",
      ownership: undefined,
    });
    expect(clientMocks.browserCloseTabByRawTargetId).not.toHaveBeenCalled();
  });

  it("retains node tracking when an opaque handle becomes stale", async () => {
    const closeTarget = vi
      .fn<() => Promise<{ status: "closed" }>>()
      .mockRejectedValueOnce(new Error("404: tab not found"))
      .mockResolvedValueOnce({ status: "closed" });
    const onWarn = vi.fn();
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "chrome-mcp:old-nonce:1",
      profile: "user",
      route: { kind: "node-proxy", nodeId: "node-1", closeTarget },
    });

    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"], onWarn }),
    ).resolves.toBe(0);
    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: ["agent:main:main"], onWarn }),
    ).resolves.toBe(1);

    expect(closeTarget).toHaveBeenCalledTimes(2);
    expect(onWarn).toHaveBeenCalledWith(
      expect.stringMatching(/failed to close tracked browser tab/i),
    );
  });

  it("coalesces overlapping lifecycle and sweep cleanup for one volatile target", async () => {
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared-tab",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9222" },
      profile: "openclaw",
      now: 1_000,
    });
    let finishClose!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      finishClose = resolve;
    });
    const closeTab = vi.fn(async () => await closeGate);

    const lifecycle = closeTrackedBrowserTabsForSessions({
      sessionKeys: ["agent:main:main"],
      closeTab,
    });
    const sweep = sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1, closeTab });
    finishClose();
    const results = await Promise.all([lifecycle, sweep]);

    expect(closeTab).toHaveBeenCalledOnce();
    expect(results.reduce((total, closed) => total + closed, 0)).toBe(1);
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

  it.each(["lifecycle", "sweep"] as const)(
    "preserves %s activity semantics while the raw client loads",
    async (kind) => {
      const tab = { sessionKey: "agent:main:main", targetId: "active-tab" };
      trackSessionBrowserTab({ ...tab, now: 1_000 });
      const cleanup =
        kind === "lifecycle"
          ? closeTrackedBrowserTabsForSessions({ sessionKeys: [tab.sessionKey] })
          : sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1 });
      await Promise.resolve();
      expect(clientMocks.browserCloseTabByRawTargetId).not.toHaveBeenCalled();
      touchSessionBrowserTab({ ...tab, now: 11_000 });
      await expect(cleanup).resolves.toBe(kind === "lifecycle" ? 1 : 0);
      expect(clientMocks.browserCloseTabByRawTargetId).toHaveBeenCalledTimes(
        kind === "lifecycle" ? 1 : 0,
      );
    },
  );

  it.each([false, true])(
    "shares lifecycle cleanup after a preparing sweep is revoked (closeFails=%s)",
    async (closeFails) => {
      const tab = { sessionKey: "agent:main:main", targetId: "touched-sweep" };
      trackSessionBrowserTab({ ...tab, now: 1_000 });
      const sweep = sweepTrackedBrowserTabs({ now: 10_000, idleMs: 1 });
      const closeTab = vi.fn(() => {
        if (closeFails) {
          throw new Error("close failed");
        }
        return Promise.resolve();
      });
      const lifecycle = () =>
        closeTrackedBrowserTabsForSessions({ sessionKeys: [tab.sessionKey], closeTab });
      const pending = [sweep, lifecycle(), lifecycle()];
      touchSessionBrowserTab({ ...tab, now: 11_000 });

      await expect(Promise.all(pending)).resolves.toEqual([0, closeFails ? 0 : 1, 0]);
      expect(clientMocks.browserCloseTabByRawTargetId).not.toHaveBeenCalled();
      expect(closeTab).toHaveBeenCalledOnce();
      const retryClose = vi.fn(async () => {});
      await expect(
        closeTrackedBrowserTabsForSessions({
          sessionKeys: [tab.sessionKey],
          closeTab: retryClose,
        }),
      ).resolves.toBe(closeFails ? 1 : 0);
      expect(retryClose).toHaveBeenCalledTimes(closeFails ? 1 : 0);
    },
  );

  it("does not adopt a new registration while an earlier selected tab closes", async () => {
    const sessionKey = "agent:main:main";
    const next = { sessionKey, targetId: "next-tab" };
    trackSessionBrowserTab({ sessionKey, targetId: "first-tab", now: 1_000 });
    trackSessionBrowserTab({ ...next, now: 1_000 });
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const closeTab = vi.fn(async ({ targetId }: { targetId: string }) => {
      if (targetId === "first-tab") {
        entered.resolve();
        await release.promise;
      }
    });
    const cleanup = closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], closeTab });
    try {
      await entered.promise;
      untrackSessionBrowserTab(next);
      trackSessionBrowserTab({ ...next, now: 1_000 });
    } finally {
      release.resolve();
    }
    await expect(cleanup).resolves.toBe(1);
    expect(closeTab).toHaveBeenCalledOnce();
    await expect(
      closeTrackedBrowserTabsForSessions({ sessionKeys: [sessionKey], closeTab }),
    ).resolves.toBe(1);
    expect(closeTab).toHaveBeenLastCalledWith(expect.objectContaining({ targetId: "next-tab" }));
  });

  it.each(["during-prepare", "before-dispatch", "during-close"] as const)(
    "preserves a registration replaced %s without dispatching against it",
    async (replacementPhase) => {
      const tab = { sessionKey: "agent:main:main", targetId: "replaced-tab" };
      trackSessionBrowserTab({ ...tab, now: 1_000 });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      let replaced = false;
      const closeTab = vi.fn(async () => {
        expect.soft(replaced).toBe(false);
        entered.resolve();
        await release.promise;
      });
      const cleanup = closeTrackedBrowserTabsForSessions({
        sessionKeys: [tab.sessionKey],
        closeTab: replacementPhase === "during-prepare" ? undefined : closeTab,
      });
      try {
        if (replacementPhase === "during-close") {
          await entered.promise;
        }
        replaced = true;
        untrackSessionBrowserTab(tab);
        trackSessionBrowserTab({ ...tab, now: 1_000 });
      } finally {
        release.resolve();
      }
      await expect(cleanup).resolves.toBe(replacementPhase === "during-prepare" ? 0 : 1);
      expect(clientMocks.browserCloseTabByRawTargetId).not.toHaveBeenCalled();
      const freshClose = vi.fn(async () => {});
      await expect(
        closeTrackedBrowserTabsForSessions({ sessionKeys: [tab.sessionKey], closeTab: freshClose }),
      ).resolves.toBe(1);
      expect(freshClose).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "retires only acquired cross-session registrations (replace=%s)",
    async (replace) => {
      const first = { sessionKey: "agent:main:first", targetId: "shared-target" };
      const second = { sessionKey: "agent:main:second", targetId: "shared-target" };
      trackSessionBrowserTab({ ...first, now: 1_000 });
      trackSessionBrowserTab({ ...second, now: 1_000 });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const closeTab = vi.fn(async () => {
        entered.resolve();
        await release.promise;
      });
      const cleanup = closeTrackedBrowserTabsForSessions({
        sessionKeys: [first.sessionKey],
        closeTab,
      });
      try {
        await entered.promise;
        if (replace) {
          untrackSessionBrowserTab(second);
          trackSessionBrowserTab({ ...second, now: 1_000 });
        }
      } finally {
        release.resolve();
      }
      await expect(cleanup).resolves.toBe(1);
      const freshClose = vi.fn(async () => {});
      await expect(
        closeTrackedBrowserTabsForSessions({
          sessionKeys: [second.sessionKey],
          closeTab: freshClose,
        }),
      ).resolves.toBe(replace ? 1 : 0);
      expect(freshClose).toHaveBeenCalledTimes(replace ? 1 : 0);
    },
  );

  it.each([false, true])(
    "binds a queued lifecycle request to its registration (replace=%s)",
    async (replace) => {
      const tab = { sessionKey: "agent:main:main", targetId: "queued-target" };
      trackSessionBrowserTab({ ...tab, now: 1_000 });
      const entered = createDeferred<void>();
      const release = createDeferred<void>();
      const firstClose = vi.fn(async () => {
        entered.resolve();
        await release.promise;
      });
      const first = closeTrackedBrowserTabsForSessions({
        sessionKeys: [tab.sessionKey],
        closeTab: firstClose,
      });
      const nextClose = vi.fn(async () => {});
      let second: Promise<number>;
      try {
        await entered.promise;
        if (replace) {
          untrackSessionBrowserTab(tab);
          trackSessionBrowserTab({ ...tab, now: 1_000 });
        }
        second = closeTrackedBrowserTabsForSessions({
          sessionKeys: [tab.sessionKey],
          closeTab: nextClose,
        });
        expect(nextClose).not.toHaveBeenCalled();
      } finally {
        release.resolve();
      }
      await expect(first).resolves.toBe(1);
      await expect(second).resolves.toBe(replace ? 1 : 0);
      expect(nextClose).toHaveBeenCalledTimes(replace ? 1 : 0);
    },
  );

  it.each(["published", "during-prepare"] as const)(
    "shares the first owner's outcome %s without retrying the registration",
    async (ownerTiming) => {
      const tab = { sessionKey: "agent:main:main", targetId: "failed-owner" };
      trackSessionBrowserTab({ ...tab, now: 1_000 });
      const release = createDeferred<void>();
      const closeTab = vi.fn(async () => {
        await release.promise;
        throw new Error("close failed");
      });
      const onWarn = vi.fn();
      const beginOwner = () =>
        closeTrackedBrowserTabsForSessions({ sessionKeys: [tab.sessionKey], closeTab, onWarn });
      const beginDefault = () =>
        closeTrackedBrowserTabsForSessions({ sessionKeys: [tab.sessionKey], onWarn });
      const first = ownerTiming === "published" ? beginOwner() : beginDefault();
      const second = ownerTiming === "published" ? beginDefault() : beginOwner();
      try {
        if (ownerTiming === "during-prepare") {
          await vi.dynamicImportSettled();
        }
        expect(clientMocks.browserCloseTabByRawTargetId).toHaveBeenCalledTimes(
          ownerTiming === "during-prepare" ? 1 : 0,
        );
      } finally {
        release.resolve();
      }
      await expect(Promise.all([first, second])).resolves.toEqual([
        ownerTiming === "during-prepare" ? 1 : 0,
        0,
      ]);
      expect(closeTab).toHaveBeenCalledTimes(ownerTiming === "published" ? 1 : 0);
      expect(onWarn).toHaveBeenCalledTimes(ownerTiming === "published" ? 1 : 0);
    },
  );

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
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9001" },
      profile: "openclaw",
      aliases: ["shared"],
      now: 1_000,
    });
    trackSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "RAW-B",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9002" },
      profile: "openclaw",
      aliases: ["shared"],
      now: 1_000,
    });
    touchSessionBrowserTab({
      sessionKey: "agent:main:main",
      targetId: "shared",
      route: { kind: "browser-control", baseUrl: "http://127.0.0.1:9001" },
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

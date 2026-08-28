import { describe, expect, it, vi } from "vitest";
import { registerTabAccessEvents } from "./tab-access-events.js";
import { createTabAccessPolicy, type TabAccessEpoch, type TabAccessMode } from "./tab-access.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

function chromeEvent<Args extends unknown[]>() {
  let listener: (...args: Args) => void = () => {
    throw new Error("Chrome event listener was not registered");
  };
  return {
    addListener(next: (...args: Args) => void) {
      listener = next;
    },
    emit(...args: Args) {
      listener(...args);
    },
  };
}

const navigationEvents = [
  { method: "Network.responseReceived", params: { requestId: "navigation-1" } },
  { method: "Runtime.executionContextCreated", params: { context: { id: 12 } } },
  { method: "Page.frameNavigated", params: { frame: { id: "frame-7", loaderId: "loader-1" } } },
  { method: "Page.lifecycleEvent", params: { frameId: "frame-7", name: "load" } },
];

async function createNavigationHarness(
  mode: TabAccessMode,
  { fileAccessAllowed = true, proveAttachment = true } = {},
) {
  let tab: BrowserTabSnapshot = {
    id: 7,
    url: "https://source.example/",
    groupId: mode === "selected" ? 11 : -1,
    incognito: false,
  };
  const chromeApi = {
    extension: { isAllowedFileSchemeAccess: async () => fileAccessAllowed },
    storage: {
      session: {
        get: async () => ({}),
        set: async () => {},
        remove: async () => {},
      },
    },
    tabs: {
      get: vi.fn(async (_tabId: number) => tab),
      query: async () => [tab],
      onUpdated: chromeEvent<[number, { groupId?: number; url?: string }, BrowserTabSnapshot]>(),
      onRemoved: chromeEvent<[number]>(),
      onReplaced: chromeEvent<[number, number]>(),
    },
    tabGroups: { onUpdated: chromeEvent<[]>(), onRemoved: chromeEvent<[]>() },
    debugger: {
      onEvent: chromeEvent<[{ tabId?: number; sessionId?: string }, string, unknown]>(),
      onDetach: chromeEvent<[{ tabId?: number }, string]>(),
    },
  };
  const policy = createTabAccessPolicy({
    chromeApi,
    isSelectedTab: async (candidate) => candidate.groupId === 11,
  });
  await policy.initialize(mode, true);
  const attachmentEpoch = policy.capture(7);
  if (proveAttachment) {
    await policy.requireTab(7, attachmentEpoch);
  }
  const attachedTabs = new Set([7]);
  const attachedAccessEpochs = new Map<number, TabAccessEpoch>([[7, attachmentEpoch]]);
  const send = vi.fn<(message: Record<string, unknown>) => void>();
  const detachDebugger = vi.fn(async (tabId: number) => {
    attachedTabs.delete(tabId);
    attachedAccessEpochs.delete(tabId);
  });
  registerTabAccessEvents({
    chromeApi,
    accessReady: Promise.resolve(),
    policy,
    attachedTabs,
    attachedAccessEpochs,
    attachingTabs: new Map(),
    send,
    scheduleTabsSync() {},
    detachDebugger,
    pauseTab: async (tabId) => await policy.pause(tabId),
    removeTabFromOpenClawGroup: async () => {},
    runAccessMutation: async (task) => await task(),
  });
  return {
    chromeApi,
    policy,
    attachmentEpoch,
    attachedAccessEpochs,
    send,
    detachDebugger,
    update(update: Partial<BrowserTabSnapshot>) {
      tab = { ...tab, ...update };
      chromeApi.tabs.onUpdated.emit(7, { url: tab.url }, tab);
    },
    emitNavigation() {
      for (const { method, params } of navigationEvents) {
        chromeApi.debugger.onEvent.emit({ tabId: 7 }, method, params);
      }
    },
    deferLookup() {
      let release = (_value: BrowserTabSnapshot) => {};
      const pending = new Promise<BrowserTabSnapshot>((resolve) => {
        release = resolve;
      });
      chromeApi.tabs.get.mockImplementation(async () => await pending);
      return async () => {
        release(tab);
        await new Promise<void>((resolve) => setImmediate(resolve));
      };
    },
  };
}

describe("Chrome navigation event access", () => {
  it.each(
    (["all", "selected"] as const).flatMap((mode) =>
      [
        "http://destination.example/",
        "https://destination.example/",
        "data:text/html,proof",
        "blob:https://destination.example/document",
        "file:///tmp/openclaw-navigation-proof.html",
      ].map((url) => ({ mode, url })),
    ),
  )("preserves ordered navigation events in $mode mode for $url", async ({ mode, url }) => {
    const harness = await createNavigationHarness(mode);
    const releaseLookup = harness.deferLookup();
    try {
      harness.update({ url });
      harness.emitNavigation();

      expect(harness.send.mock.calls.map(([frame]) => frame)).toEqual(
        navigationEvents.map((event) => ({ type: "cdpEvent", tabId: 7, ...event })),
      );
      await expect(harness.policy.requireTab(7, harness.attachmentEpoch)).rejects.toThrow(
        "access was revoked",
      );

      harness.send.mockClear();
      harness.update({ url: `${url}next` });
      harness.emitNavigation();
      expect(harness.send.mock.calls.map(([frame]) => frame.method)).toEqual(
        navigationEvents.map((event) => event.method),
      );
    } finally {
      await releaseLookup();
    }
    expect(harness.detachDebugger).not.toHaveBeenCalled();
  });

  it.each([
    "restricted committed URL",
    "restricted pending URL",
    "incognito tab",
    "different selected group",
    "wrong tab identity",
    "paused tab",
    "mode transition",
    "changed group authority",
    "stale attachment",
    "unproven attachment",
    "forged epoch copy",
    "detached tab",
    "replaced tab",
  ])("does not renew access for %s from a URL snapshot", async (scenario) => {
    const harness = await createNavigationHarness(scenario === "paused tab" ? "all" : "selected", {
      proveAttachment: scenario !== "unproven attachment",
    });
    const update: Partial<BrowserTabSnapshot> = { url: "https://destination.example/" };
    if (scenario === "paused tab") {
      await harness.policy.pause(7);
    }
    const releaseLookup = harness.deferLookup();
    try {
      switch (scenario) {
        case "restricted committed URL":
          update.url = "chrome://settings";
          break;
        case "restricted pending URL":
          update.pendingUrl = "chrome://settings";
          break;
        case "incognito tab":
          update.incognito = true;
          break;
        case "different selected group":
          update.groupId = 12;
          break;
        case "wrong tab identity":
          update.id = 8;
          break;
        case "mode transition":
          harness.policy.beginTransition();
          break;
        case "changed group authority":
          harness.chromeApi.tabGroups.onUpdated.emit();
          break;
        case "stale attachment":
          harness.policy.invalidateTab(7);
          break;
        case "forged epoch copy":
          harness.attachedAccessEpochs.set(7, { ...harness.attachmentEpoch });
          break;
        case "detached tab":
          harness.chromeApi.debugger.onDetach.emit({ tabId: 7 }, "target_closed");
          break;
        case "replaced tab":
          harness.chromeApi.tabs.onReplaced.emit(8, 7);
          break;
      }
      harness.send.mockClear();
      harness.update(update);
      harness.emitNavigation();
      expect(harness.send).not.toHaveBeenCalled();
    } finally {
      await releaseLookup();
    }
    // Events observed without authority must never replay after an async lookup.
    expect(harness.send).not.toHaveBeenCalled();
  });

  it("does not retain file permission across a recreated extension policy", async () => {
    for (const fileAccessAllowed of [true, false]) {
      const harness = await createNavigationHarness("all", { fileAccessAllowed });
      const releaseLookup = harness.deferLookup();
      try {
        harness.update({ url: "file:///tmp/openclaw-navigation-proof.html" });
        harness.emitNavigation();
        expect(harness.send).toHaveBeenCalledTimes(fileAccessAllowed ? navigationEvents.length : 0);
      } finally {
        await releaseLookup();
      }
      if (!fileAccessAllowed) {
        await expect(harness.policy.requireTab(7)).rejects.toThrow("restricted or unavailable");
      }
    }
  });
});

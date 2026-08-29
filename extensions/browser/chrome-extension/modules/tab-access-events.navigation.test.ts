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
  {
    fileAccessAllowed = true,
    proveAttachment = true,
    groupId = mode === "selected" ? 11 : -1,
  } = {},
) {
  let tab: BrowserTabSnapshot = {
    id: 7,
    url: "https://source.example/",
    groupId,
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
      query: vi.fn(async () => [tab]),
      onUpdated: chromeEvent<[number, { groupId?: number; url?: string }, BrowserTabSnapshot]>(),
      onRemoved: chromeEvent<[number]>(),
      onReplaced: chromeEvent<[number, number]>(),
    },
    tabGroups: {
      onUpdated: chromeEvent<[group?: { id: number; title?: string }]>(),
      onRemoved: chromeEvent<[group?: { id: number; title?: string }]>(),
    },
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
    setTab(update: Partial<BrowserTabSnapshot>) {
      tab = { ...tab, ...update };
    },
    async controlBlank() {
      const epoch = policy.capture(7, "Page.navigate");
      await policy.requireTab(7, epoch);
      await policy.navigateTab(
        7,
        epoch,
        { url: "about:blank" },
        () => attachedAccessEpochs.get(7),
        () => true,
        async (method) => {
          if (method === "Page.getFrameTree") {
            return { frameTree: { frame: { id: "root", url: tab.url } } };
          }
          tab = { ...tab, url: "about:blank" };
          chromeApi.debugger.onEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
            frame: { id: "root", loaderId: "blank", url: tab.url },
          });
          return { frameId: "root", loaderId: "blank" };
        },
      );
      await expect(policy.requireTab(7)).resolves.toMatchObject({ url: "about:blank" });
    },
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
        await new Promise<void>((resolve) => {
          setImmediate(resolve);
        });
      };
    },
  };
}

describe("Chrome navigation event access", () => {
  it("projects native child session ids only while the attachment epoch is current", async () => {
    const harness = await createNavigationHarness("selected");
    const params = { frame: { id: "child", loaderId: "child-loader", url: "about:blank" } };
    for (const source of [{ tabId: 7 }, { tabId: 7, sessionId: "child-session" }]) {
      harness.chromeApi.debugger.onEvent.emit(source, "Page.frameNavigated", params);
    }
    expect(harness.send.mock.calls.map(([event]) => event)).toEqual([
      { type: "cdpEvent", tabId: 7, method: "Page.frameNavigated", params },
      {
        type: "cdpEvent",
        tabId: 7,
        sessionId: "child-session",
        method: "Page.frameNavigated",
        params,
      },
    ]);
    harness.send.mockClear();
    harness.policy.invalidateTab(7);
    harness.chromeApi.debugger.onEvent.emit({ tabId: 7 }, "Page.frameNavigated", params);
    harness.chromeApi.debugger.onEvent.emit(
      { tabId: 7, sessionId: "child-session" },
      "Page.frameNavigated",
      params,
    );
    expect(harness.send).not.toHaveBeenCalled();
  });

  it.each([
    "pause",
    "mode change",
    "disable",
    "transition",
    "remove",
    "replace",
    "detach",
    "group rename",
    "group removal",
  ])("retires controlled blank authority on %s without reauthorizing it", async (reason) => {
    const harness = await createNavigationHarness("all", { groupId: 11 });
    await harness.controlBlank();
    switch (reason) {
      case "pause":
        await harness.policy.pause(7);
        expect(harness.policy.isDenied(7)).toBe(true);
        await harness.policy.allow(7);
        break;
      case "mode change":
        harness.policy.setMode("selected");
        harness.policy.setMode("all");
        break;
      case "disable":
        harness.policy.setEnabled(false);
        harness.policy.setEnabled(true);
        break;
      case "transition":
        harness.policy.beginTransition();
        harness.policy.endTransition();
        break;
      case "remove":
        harness.chromeApi.tabs.onRemoved.emit(7);
        break;
      case "replace":
        harness.chromeApi.tabs.onReplaced.emit(8, 7);
        break;
      case "detach":
        harness.chromeApi.debugger.onDetach.emit({ tabId: 7 }, "target_closed");
        break;
      case "group rename":
        harness.chromeApi.tabGroups.onUpdated.emit({ id: 12, title: "Other" });
        await expect(harness.policy.requireTab(7)).resolves.toMatchObject({ url: "about:blank" });
        harness.chromeApi.tabGroups.onUpdated.emit({ id: 11, title: "Other" });
        break;
      case "group removal":
        harness.chromeApi.tabGroups.onRemoved.emit({ id: 12 });
        await expect(harness.policy.requireTab(7)).resolves.toMatchObject({ url: "about:blank" });
        harness.chromeApi.tabGroups.onRemoved.emit({ id: 11 });
        break;
    }
    harness.send.mockClear();
    harness.emitNavigation();
    await expect(harness.policy.requireTab(7)).rejects.toThrow(
      reason === "remove" || reason === "replace"
        ? "access was revoked"
        : "restricted or unavailable",
    );
    await expect(harness.policy.requireTab(7)).rejects.toThrow("restricted or unavailable");
    expect(harness.send).not.toHaveBeenCalled();
  });

  it.each(["source before blank", "blank before return"])(
    "discards a stale selected discovery snapshot of %s before consuming provenance",
    async (snapshot) => {
      const harness = await createNavigationHarness("selected");
      if (snapshot === "blank before return") {
        await harness.controlBlank();
      }
      const stale = await harness.chromeApi.tabs.query();
      let release = (_tabs: BrowserTabSnapshot[]) => {};
      const lookup = new Promise<BrowserTabSnapshot[]>((resolve) => {
        release = resolve;
      });
      let queried = () => {};
      const started = new Promise<void>((resolve) => {
        queried = resolve;
      });
      harness.chromeApi.tabs.query.mockImplementationOnce(() => {
        queried();
        return lookup;
      });
      const discovering = harness.policy.listAccessibleTabs();
      await started;
      try {
        if (snapshot === "source before blank") {
          await harness.controlBlank();
        } else {
          harness.setTab({ url: "https://return.example/" });
          harness.chromeApi.debugger.onEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
            frame: { id: "root", loaderId: "return", url: "https://return.example/" },
          });
        }
      } finally {
        release(stale);
      }
      const url = snapshot === "source before blank" ? "about:blank" : "https://return.example/";
      await expect(discovering).resolves.toEqual([expect.objectContaining({ id: 7, url })]);
      await expect(harness.policy.requireTab(7)).resolves.toMatchObject({ id: 7, url });
    },
  );

  it("rereads a selected lookup overtaken by a native root commit before checking provenance", async () => {
    const harness = await createNavigationHarness("selected");
    await harness.controlBlank();
    const get = harness.chromeApi.tabs.get.getMockImplementation()!;
    harness.chromeApi.tabs.get.mockImplementationOnce(async (tabId) => {
      const stale = await get(tabId);
      harness.setTab({ url: "https://return.example/" });
      harness.chromeApi.debugger.onEvent.emit({ tabId: 7 }, "Page.frameNavigated", {
        frame: { id: "root", loaderId: "return", url: "https://return.example/" },
      });
      return stale;
    });
    await expect(harness.policy.requireTab(7)).resolves.toMatchObject({
      url: "https://return.example/",
    });
  });

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

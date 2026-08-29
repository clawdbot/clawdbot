import assert from "node:assert/strict";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayCommandHandler } from "./relay-command-handler.js";

function createHarness() {
  const send = vi.fn();
  const epoch = { revision: 1, tabRevision: 2 };
  const requireAccessibleTab = vi.fn(async () => ({ id: 7, windowId: 3 }));
  const requireNavigatedTab = vi.fn(async () => ({ id: 7, windowId: 3 }));
  const navigateTab = vi.fn(async () => ({ frameId: "root", loaderId: "blank-loader" }));
  const detachDebugger = vi.fn(async () => undefined);
  const focusWindowForTab = vi.fn(async () => undefined);
  const chromeMock = {
    debugger: { sendCommand: vi.fn(async () => ({ value: 1 })) },
    tabs: {
      create: vi.fn(),
      remove: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
    },
  };
  vi.stubGlobal("chrome", chromeMock);
  const handler = createRelayCommandHandler({
    send,
    isCurrent: () => true,
    attachDebugger: vi.fn(),
    captureDebugger: vi.fn(() => () => {}),
    detachDebugger,
    createTab: vi.fn(),
    scheduleTabsSync: vi.fn(),
    focusWindowForTab,
    captureAccess: vi.fn(() => epoch),
    navigateTab,
    requireAccessibleTab,
    requireNavigatedTab,
  });
  return {
    chromeMock,
    detachDebugger,
    epoch,
    focusWindowForTab,
    handler: (message: Record<string, unknown>) => handler(message),
    navigateTab,
    requireAccessibleTab,
    requireNavigatedTab,
    send,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("relay authority rechecks", () => {
  it.each([
    { name: "evaluation", method: "Runtime.evaluate", params: undefined, sessionId: undefined },
    {
      name: "nonblank navigation",
      method: "Page.navigate",
      params: { url: "https://example.com" },
      sessionId: undefined,
    },
    {
      name: "blank fragment navigation",
      method: "Page.navigate",
      params: { url: "about:blank#other" },
      sessionId: undefined,
    },
    {
      name: "child-session blank navigation",
      method: "Page.navigate",
      params: { url: "about:blank" },
      sessionId: "child",
    },
    { name: "reload", method: "Page.reload", params: {}, sessionId: undefined },
    {
      name: "history navigation",
      method: "Page.navigateToHistoryEntry",
      params: { entryId: 9 },
      sessionId: undefined,
    },
  ])("checks ordinary access around native $name", async ({ method, params, sessionId }) => {
    const harness = createHarness();
    await harness.handler({ type: "cdp", seq: 1, tabId: 7, method, params, sessionId });
    expect(harness.chromeMock.debugger.sendCommand).toHaveBeenCalledExactlyOnceWith(
      sessionId ? { tabId: 7, sessionId } : { tabId: 7 },
      method,
      params ?? {},
    );
    expect(harness.requireAccessibleTab.mock.calls).toEqual([
      [7, harness.epoch],
      [7, harness.epoch],
    ]);
    const [beforeCommand, afterCommand] = harness.requireAccessibleTab.mock.invocationCallOrder;
    const [command] = harness.chromeMock.debugger.sendCommand.mock.invocationCallOrder;
    assert(beforeCommand !== undefined && command !== undefined && afterCommand !== undefined);
    expect(beforeCommand).toBeLessThan(command);
    expect(command).toBeLessThan(afterCommand);
    expect(harness.navigateTab).not.toHaveBeenCalled();
    expect(harness.requireNavigatedTab).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith({ type: "result", seq: 1, result: { value: 1 } });
  });

  it("routes root sessionless literal blank navigation through provenance and its post-check", async () => {
    const harness = createHarness();
    const params = { url: "about:blank", frameId: "root" };
    await harness.handler({ type: "cdp", seq: 5, tabId: 7, method: "Page.navigate", params });
    expect(harness.requireAccessibleTab).toHaveBeenCalledExactlyOnceWith(7, harness.epoch);
    expect(harness.navigateTab).toHaveBeenCalledExactlyOnceWith(
      7,
      harness.epoch,
      params,
      expect.any(Function),
      expect.any(Function),
    );
    expect(harness.requireNavigatedTab).toHaveBeenCalledExactlyOnceWith(7, harness.epoch);
    const [beforeNavigation] = harness.requireAccessibleTab.mock.invocationCallOrder;
    const [navigation] = harness.navigateTab.mock.invocationCallOrder;
    const [afterNavigation] = harness.requireNavigatedTab.mock.invocationCallOrder;
    assert(
      beforeNavigation !== undefined && navigation !== undefined && afterNavigation !== undefined,
    );
    expect(beforeNavigation).toBeLessThan(navigation);
    expect(navigation).toBeLessThan(afterNavigation);
    expect(harness.chromeMock.debugger.sendCommand).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith({
      type: "result",
      seq: 5,
      result: { frameId: "root", loaderId: "blank-loader" },
    });
  });

  it("reports a revoked navigated-tab post-check instead of a successful native result", async () => {
    const harness = createHarness();
    harness.requireNavigatedTab.mockRejectedValueOnce(new Error("tab 7 navigation was revoked"));
    await harness.handler({
      type: "cdp",
      seq: 6,
      tabId: 7,
      method: "Page.navigate",
      params: { url: "about:blank" },
    });
    expect(harness.navigateTab).toHaveBeenCalledOnce();
    expect(harness.send).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      seq: 6,
      message: "tab 7 navigation was revoked",
    });
  });

  it("checks access around tab activation and window focus", async () => {
    const harness = createHarness();
    await harness.handler({ type: "activateTab", seq: 2, tabId: 7 });
    expect(harness.requireAccessibleTab).toHaveBeenCalledTimes(3);
    expect(harness.chromeMock.tabs.update).toHaveBeenCalledWith(7, { active: true });
    expect(harness.focusWindowForTab).toHaveBeenCalled();
  });

  it("checks access immediately before close and reports the successful removal", async () => {
    const harness = createHarness();
    await harness.handler({ type: "closeTab", seq: 3, tabId: 7 });
    expect(harness.requireAccessibleTab).toHaveBeenCalledExactlyOnceWith(7, harness.epoch);
    expect(harness.chromeMock.tabs.remove).toHaveBeenCalledWith(7);
    expect(harness.detachDebugger).not.toHaveBeenCalled();
    expect(harness.send).toHaveBeenCalledWith({ type: "result", seq: 3, result: {} });
  });

  it("does not report a post-operation result when access changes during CDP", async () => {
    const harness = createHarness();
    harness.requireAccessibleTab
      .mockResolvedValueOnce({ id: 7, windowId: 3 })
      .mockRejectedValueOnce(new Error("tab 7 access was revoked"));
    await harness.handler({ type: "cdp", seq: 4, tabId: 7, method: "Runtime.evaluate" });
    expect(harness.send).toHaveBeenCalledWith({
      type: "error",
      seq: 4,
      message: "tab 7 access was revoked",
    });
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { createRelayCommandHandler } from "./relay-command-handler.js";

function createHarness() {
  const send = vi.fn();
  const epoch = { revision: 1, tabRevision: 2 };
  const requireAccessibleTab = vi.fn(async () => ({ id: 7, windowId: 3 }));
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
    attachDebugger: vi.fn(),
    detachDebugger: vi.fn(async () => undefined),
    createTab: vi.fn(),
    scheduleTabsSync: vi.fn(),
    focusWindowForTab,
    captureAccess: vi.fn(() => epoch),
    navigateTab: vi.fn(),
    requireAccessibleTab,
    requireNavigatedTab: requireAccessibleTab,
  });
  return {
    chromeMock,
    epoch,
    focusWindowForTab,
    handler: (message: Record<string, unknown>) => handler(message, () => true),
    requireAccessibleTab,
    send,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("relay authority rechecks", () => {
  it("checks access before and after an async CDP command", async () => {
    const harness = createHarness();
    await harness.handler({ type: "cdp", seq: 1, tabId: 7, method: "Runtime.evaluate" });
    expect(harness.requireAccessibleTab.mock.calls).toEqual([
      [7, harness.epoch],
      [7, harness.epoch],
    ]);
    expect(harness.send).toHaveBeenCalledWith({ type: "result", seq: 1, result: { value: 1 } });
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
    expect(harness.requireAccessibleTab.mock.calls).toEqual([
      [7, harness.epoch],
      [7, harness.epoch],
    ]);
    expect(harness.chromeMock.tabs.remove).toHaveBeenCalledWith(7);
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

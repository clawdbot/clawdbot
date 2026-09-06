import { afterEach, describe, expect, it, vi } from "vitest";
import { registerTabAccessEvents } from "./tab-access-events.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

function deferred<T>() {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createHarness(
  mode: "all" | "selected" = "selected",
  accessReady: Promise<unknown> = Promise.resolve(),
) {
  let debuggerEventListener:
    | ((source: { tabId?: number }, method: string, params: unknown) => void)
    | undefined;
  let debuggerDetachListener: ((source: { tabId?: number }, reason: string) => void) | undefined;
  let tabsUpdatedListener:
    | ((
        tabId: number,
        changeInfo: { groupId?: number; url?: string },
        tab: BrowserTabSnapshot,
      ) => void)
    | undefined;
  let tabsReplacedListener: ((addedTabId: number, removedTabId: number) => void) | undefined;
  let groupUpdatedListener: ((group?: { id: number; title?: string }) => void) | undefined;
  let revision = 0;
  let accessible = true;
  const attachments = new Map([[7, { epoch: { revision: 0, groupRevision: 0, tabRevision: 0 } }]]);
  const send = vi.fn();
  const policy = {
    mode,
    observeTabUpdate: vi.fn(
      (_tabId: number, change: { url?: string; groupId?: number }) =>
        typeof change.url === "string" ||
        (mode === "selected" && typeof change.groupId === "number"),
    ),
    retireTab: vi.fn(() => {
      revision += 1;
    }),
    beginRevocation: vi.fn(() => Symbol("revocation")),
    endRevocation: vi.fn(),
    capture: vi.fn(() => ({ revision, groupRevision: 0, tabRevision: 0 })),
    epochIsCurrent: vi.fn(
      (_tabId: number, epoch: { revision: number }) => epoch.revision === revision,
    ),
    invalidateTab: vi.fn(() => {
      revision += 1;
    }),
    renewTabAccess: vi.fn(() => {
      revision += 1;
      return undefined;
    }),
    forwardDocumentEvent: vi.fn((event, emit) => emit(event)),
    invalidateGroup: vi.fn(() => {
      revision += 1;
      return true;
    }),
    inspectTab: vi.fn(async (_tabId: number, epoch: { revision: number }) => ({
      accessible: accessible && epoch.revision === revision,
    })),
    listAccessibleTabs: vi.fn(async () => (accessible ? [{ id: 7 }] : [])),
    forgetTab: vi.fn(async () => undefined),
    replaceTab: vi.fn(async () => false),
  };
  const detachDebugger = vi.fn(async (tabId: number) => {
    attachments.delete(tabId);
  });
  const pauseTab = vi.fn(async () => undefined);
  const removeTabFromOpenClawGroup = vi.fn(async () => undefined);
  const chromeApi = {
    debugger: {
      onEvent: {
        addListener: (listener: typeof debuggerEventListener) => {
          debuggerEventListener = listener;
        },
      },
      onDetach: {
        addListener: (listener: typeof debuggerDetachListener) => {
          debuggerDetachListener = listener;
        },
      },
    },
    tabs: {
      onRemoved: { addListener: vi.fn() },
      onReplaced: {
        addListener: (listener: typeof tabsReplacedListener) => {
          tabsReplacedListener = listener;
        },
      },
      onUpdated: {
        addListener: (listener: typeof tabsUpdatedListener) => {
          tabsUpdatedListener = listener;
        },
      },
    },
    tabGroups: {
      onUpdated: {
        addListener: (listener: (group?: { id: number; title?: string }) => void) => {
          groupUpdatedListener = listener;
        },
      },
      onRemoved: { addListener: vi.fn() },
    },
  };

  registerTabAccessEvents({
    chromeApi,
    accessReady,
    policy,
    attachments,
    nativeDetached: (tabId: number) => attachments.delete(tabId),
    send,
    scheduleTabsSync: vi.fn(),
    detachDebugger,
    pauseTab,
    removeTabFromOpenClawGroup,
    runAccessMutation: vi.fn(async (task) => await task()),
  });
  if (
    !debuggerEventListener ||
    !debuggerDetachListener ||
    !tabsUpdatedListener ||
    !tabsReplacedListener ||
    !groupUpdatedListener
  ) {
    throw new Error("expected tab access event listeners");
  }
  return {
    attachments,
    detachDebugger,
    debuggerDetachListener,
    debuggerEventListener,
    groupUpdatedListener,
    policy,
    pauseTab,
    removeTabFromOpenClawGroup,
    send,
    setAccessible: (next: boolean) => {
      accessible = next;
    },
    tabsUpdatedListener: (tabId: number, changeInfo: { groupId?: number; url?: string }) =>
      tabsUpdatedListener?.(tabId, changeInfo, { id: tabId, ...changeInfo }),
    tabsReplacedListener,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("tab access event epochs", () => {
  it("waits for stored access mode before handling Chrome's cancel revocation", async () => {
    const ready = deferred<void>();
    const harness = createHarness("selected", ready.promise);

    harness.debuggerDetachListener({ tabId: 7 }, "canceled_by_user");
    expect(harness.policy.beginRevocation).toHaveBeenCalledWith(7);
    expect(harness.pauseTab).not.toHaveBeenCalled();
    expect(harness.removeTabFromOpenClawGroup).not.toHaveBeenCalled();

    harness.policy.mode = "all";
    ready.resolve();
    await vi.waitFor(() => expect(harness.pauseTab).toHaveBeenCalledWith(7));

    expect(harness.removeTabFromOpenClawGroup).not.toHaveBeenCalled();
    expect(harness.policy.endRevocation).toHaveBeenCalledOnce();
  });

  it.each([
    {
      label: "all-mode URL",
      mode: "all",
      firstChange: { url: "https://one.example" },
      secondChange: { url: "https://two.example" },
    },
    {
      label: "selected-mode URL",
      mode: "selected",
      firstChange: { url: "https://one.example" },
      secondChange: { url: "https://two.example" },
    },
    {
      label: "selected-mode group",
      mode: "selected",
      firstChange: { groupId: 7 },
      secondChange: { groupId: 7 },
    },
  ] as const)(
    "ignores a stale $label revocation after a newer eligible update",
    async ({ mode, firstChange, secondChange }) => {
      const harness = createHarness(mode);
      const firstInspection = deferred<{ accessible: boolean }>();
      let firstInspectionResumed = false;
      harness.policy.inspectTab
        .mockImplementationOnce(async () => {
          const state = await firstInspection.promise;
          firstInspectionResumed = true;
          return state;
        })
        .mockResolvedValueOnce({ accessible: true });

      harness.tabsUpdatedListener(7, firstChange);
      await vi.waitFor(() => expect(harness.policy.inspectTab).toHaveBeenCalledTimes(1));
      harness.tabsUpdatedListener(7, secondChange);
      await vi.waitFor(() => {
        expect(harness.attachments.get(7)?.epoch).toEqual({
          revision: 2,
          groupRevision: 0,
          tabRevision: 0,
        });
      });

      firstInspection.resolve({ accessible: false });
      await vi.waitFor(() => expect(firstInspectionResumed).toBe(true));
      await Promise.resolve();

      expect(harness.detachDebugger).not.toHaveBeenCalled();
      harness.debuggerEventListener({ tabId: 7 }, "Runtime.consoleAPICalled", {});
      expect(harness.send).toHaveBeenCalledWith(
        expect.objectContaining({ type: "cdpEvent", tabId: 7 }),
      );
    },
  );

  it.each([
    {
      label: "all-mode URL",
      mode: "all",
      firstChange: { url: "https://one.example" },
      secondChange: { url: "chrome://settings" },
    },
    {
      label: "selected-mode URL",
      mode: "selected",
      firstChange: { url: "https://one.example" },
      secondChange: { url: "chrome://settings" },
    },
    {
      label: "selected-mode group",
      mode: "selected",
      firstChange: { groupId: 7 },
      secondChange: { groupId: -1 },
    },
  ] as const)(
    "lets the current restricted $label update revoke exactly once when an older update resumes",
    async ({ mode, firstChange, secondChange }) => {
      const harness = createHarness(mode);
      const firstInspection = deferred<{ accessible: boolean }>();
      let firstInspectionResumed = false;
      harness.policy.inspectTab
        .mockImplementationOnce(async () => {
          const state = await firstInspection.promise;
          firstInspectionResumed = true;
          return state;
        })
        .mockResolvedValueOnce({ accessible: false });

      harness.tabsUpdatedListener(7, firstChange);
      await vi.waitFor(() => expect(harness.policy.inspectTab).toHaveBeenCalledTimes(1));
      harness.tabsUpdatedListener(7, secondChange);
      await vi.waitFor(() => {
        expect(harness.detachDebugger).toHaveBeenCalledTimes(1);
      });

      firstInspection.resolve({ accessible: false });
      await vi.waitFor(() => expect(firstInspectionResumed).toBe(true));
      await Promise.resolve();

      expect(harness.detachDebugger).toHaveBeenCalledTimes(1);
    },
  );

  it("cleans up both tab identities after Chrome replaces a paused tab", async () => {
    const harness = createHarness("all");
    harness.policy.replaceTab.mockResolvedValueOnce(true);

    harness.tabsReplacedListener(8, 7);

    await vi.waitFor(() => {
      expect(harness.policy.replaceTab).toHaveBeenCalledWith(8, 7);
      expect(harness.detachDebugger).toHaveBeenCalledWith(7);
      expect(harness.detachDebugger).toHaveBeenCalledWith(8);
    });
  });

  it("does not refresh epochs from a stale group-wide access snapshot", async () => {
    vi.stubGlobal("chrome", { tabGroups: { get: vi.fn() } });
    const harness = createHarness();
    const firstList = deferred<Array<{ id: number }>>();
    harness.policy.listAccessibleTabs
      .mockImplementationOnce(async () => await firstList.promise)
      .mockResolvedValueOnce([{ id: 7 }]);

    harness.groupUpdatedListener();
    await vi.waitFor(() => expect(harness.policy.listAccessibleTabs).toHaveBeenCalledTimes(1));
    harness.groupUpdatedListener();
    await vi.waitFor(() => expect(harness.policy.listAccessibleTabs).toHaveBeenCalledTimes(2));
    harness.setAccessible(false);
    harness.policy.invalidateTab();
    firstList.resolve([{ id: 7 }]);
    await Promise.resolve();

    harness.debuggerEventListener({ tabId: 7 }, "Network.requestWillBeSent", {});
    expect(harness.send).not.toHaveBeenCalled();
  });
});

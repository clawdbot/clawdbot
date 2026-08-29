import type { TabAccessEpoch, TabAccessMode } from "./tab-access.js";
import type { BrowserTabSnapshot } from "./tab-eligibility.js";

type ChromeEvent<Listener> = {
  addListener(listener: Listener): void;
};

export type TabAccessEventsChromeApi = {
  debugger: {
    onEvent: ChromeEvent<
      (source: { tabId?: number; sessionId?: string }, method: string, params: unknown) => void
    >;
    onDetach: ChromeEvent<(source: { tabId?: number }, reason: string) => void>;
  };
  tabs: {
    onRemoved: ChromeEvent<(tabId: number) => void>;
    onReplaced: ChromeEvent<(addedTabId: number, removedTabId: number) => void>;
    onUpdated: ChromeEvent<
      (
        tabId: number,
        changeInfo: { groupId?: number; url?: string },
        tab: BrowserTabSnapshot,
      ) => void
    >;
  };
  tabGroups: {
    onUpdated: ChromeEvent<() => void>;
    onRemoved: ChromeEvent<() => void>;
  };
};

export type TabAccessEventPolicy = {
  readonly mode: TabAccessMode;
  beginRevocation(tabId: number): symbol;
  endRevocation(token: symbol): void;
  capture(tabId: number): TabAccessEpoch;
  epochIsCurrent(tabId: number, epoch: TabAccessEpoch): boolean;
  invalidateTab(tabId: number): void;
  renewTabAccess(
    tabId: number,
    attachedEpoch: TabAccessEpoch | undefined,
    tab: BrowserTabSnapshot | undefined,
  ): TabAccessEpoch | undefined;
  invalidateAll(): void;
  inspectTab(tabId: number, epoch: TabAccessEpoch): Promise<{ accessible: boolean }>;
  listAccessibleTabs(): Promise<Array<{ id: number }>>;
  forgetTab(tabId: number): Promise<void>;
  replaceTab(addedTabId: number, removedTabId: number): Promise<boolean>;
};

export function registerTabAccessEvents(options: {
  chromeApi?: TabAccessEventsChromeApi;
  accessReady: Promise<unknown>;
  policy: TabAccessEventPolicy;
  attachedTabs: Set<number>;
  attachedAccessEpochs: Map<number, TabAccessEpoch>;
  attachingTabs: Map<number, Promise<unknown>>;
  send(message: Record<string, unknown>): void;
  scheduleTabsSync(): void;
  detachDebugger(tabId: number): Promise<void>;
  pauseTab(tabId: number): void | Promise<void>;
  removeTabFromOpenClawGroup(tabId: number): void | Promise<void>;
  runAccessMutation(task: () => void | Promise<void>): Promise<void>;
}): void;

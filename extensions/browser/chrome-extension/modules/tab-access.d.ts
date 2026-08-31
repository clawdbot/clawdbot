import type {
  AccessibleBrowserTabSnapshot,
  BrowserTabSnapshot,
  TabEligibilityReason,
} from "./tab-eligibility.js";

export type TabAccessMode = "all" | "selected";

export type CreatedTabOperation = {
  isCurrent(): boolean;
  attachDebugger(
    tabId: number,
    assertCurrent: () => void,
    creationEpoch?: TabAccessEpoch,
  ): Promise<{ targetId: string; assertCurrent(): void }>;
  handoff(result: { tabId: number; targetId: string }): void;
};

type TabGroupSnapshot = { id: number; title?: string };

export type TabAccessEpoch = Readonly<{
  revision: number;
  tabRevision: number;
  documentRevision?: number;
}>;

export type TabAccessReason = TabEligibilityReason | "revoked" | "paused" | "not-selected" | null;

export type TabAccessState = {
  accessible: boolean;
  eligible: boolean;
  denied: boolean;
  reason: TabAccessReason;
  tab: BrowserTabSnapshot | null;
};

export type TabAccessStorageArea = {
  get(keys: string[]): Promise<Record<string, unknown>>;
  set(values: Record<string, unknown>): Promise<void>;
  remove(keys: string[]): Promise<void>;
};

export type TabAccessChromeApi = {
  extension?: {
    isAllowedFileSchemeAccess?: () => boolean | Promise<boolean>;
  };
  storage: { session: TabAccessStorageArea };
  tabs: {
    get(tabId: number): Promise<BrowserTabSnapshot>;
    query(queryInfo: Record<string, unknown>): Promise<BrowserTabSnapshot[]>;
  };
};

export type TabAccessPolicy = {
  initialize(initialMode?: TabAccessMode, initialEnabled?: boolean): Promise<void>;
  readonly mode: TabAccessMode;
  setMode(nextMode: TabAccessMode): TabAccessMode;
  setEnabled(nextEnabled: boolean): void;
  beginTransition(): void;
  endTransition(): void;
  beginRevocation(tabId: number): symbol;
  endRevocation(token: symbol): void;
  capture(tabId: number, method?: string): TabAccessEpoch;
  epochIsCurrent(tabId: number, epoch: TabAccessEpoch): boolean;
  invalidateTab(tabId: number): void;
  retireTab(tabId: number): void;
  retireTabDocument(tabId: number): void;
  forwardDocumentEvent(
    event: Record<string, unknown>,
    send: (event: Record<string, unknown>) => void,
  ): void;
  navigateTab(
    tabId: number,
    epoch: TabAccessEpoch,
    params: Record<string, unknown>,
    isAttached: () => TabAccessEpoch | undefined,
    isConnectionCurrent: () => boolean,
    sendCommand: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ): Promise<unknown>;
  invalidateDocumentGroup(group?: TabGroupSnapshot): void;
  renewTabAccess(
    tabId: number,
    attachedEpoch: TabAccessEpoch | undefined,
    tab: BrowserTabSnapshot | undefined,
  ): TabAccessEpoch | undefined;
  invalidateAll(group?: TabGroupSnapshot): void;
  observeTabUpdate(
    tabId: number,
    change: { url?: string; groupId?: number; status?: string },
    tab?: BrowserTabSnapshot,
  ): boolean;
  addTabToGroup(tabId: number): Promise<void>;
  createTab(
    message: { url: string; background?: boolean; focus?: boolean },
    operation: CreatedTabOperation,
  ): Promise<void>;
  inspectTab(tabId: number, epoch?: TabAccessEpoch): Promise<TabAccessState>;
  requireTab(tabId: number, epoch?: TabAccessEpoch): Promise<AccessibleBrowserTabSnapshot>;
  requireTabAfterNavigation(
    tabId: number,
    epoch: TabAccessEpoch,
  ): Promise<AccessibleBrowserTabSnapshot>;
  listAccessibleTabs(options?: {
    allowDuringTransition?: boolean;
  }): Promise<AccessibleBrowserTabSnapshot[]>;
  canPublishTab(tabId: number): boolean;
  pause(tabId: number): Promise<void>;
  allow(tabId: number): Promise<void>;
  forgetTab(tabId: number): Promise<void>;
  replaceTab(addedTabId: number, removedTabId: number): Promise<boolean>;
  clearDenied(): Promise<void>;
  isDenied(tabId: number): boolean;
};

export function createTabAccessPolicy(options: {
  chromeApi?: TabAccessChromeApi;
  isSelectedTab(tab: BrowserTabSnapshot): boolean | Promise<boolean>;
  getGroupColor?(): Promise<string>;
}): TabAccessPolicy;

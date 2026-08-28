import type {
  AccessibleBrowserTabSnapshot,
  BrowserTabSnapshot,
  TabEligibilityReason,
} from "./tab-eligibility.js";

export type TabAccessMode = "all" | "selected";

export type TabAccessEpoch = Readonly<{
  revision: number;
  tabRevision: number;
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
  capture(tabId: number): TabAccessEpoch;
  epochIsCurrent(tabId: number, epoch: TabAccessEpoch): boolean;
  invalidateTab(tabId: number): void;
  renewTabAccess(
    tabId: number,
    attachedEpoch: TabAccessEpoch | undefined,
    tab: BrowserTabSnapshot | undefined,
  ): TabAccessEpoch | undefined;
  invalidateAll(): void;
  inspectTab(tabId: number, epoch?: TabAccessEpoch): Promise<TabAccessState>;
  requireTab(tabId: number, epoch?: TabAccessEpoch): Promise<AccessibleBrowserTabSnapshot>;
  listAccessibleTabs(options?: {
    allowDuringTransition?: boolean;
  }): Promise<AccessibleBrowserTabSnapshot[]>;
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
}): TabAccessPolicy;

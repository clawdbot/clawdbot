export type BrowserTabSnapshot = {
  id?: number;
  url?: string;
  pendingUrl?: string;
  title?: string;
  active?: boolean;
  incognito?: boolean;
  groupId?: number;
  windowId?: number;
};

export type AccessibleBrowserTabSnapshot = BrowserTabSnapshot & { id: number };

export type TabEligibilityReason = "missing" | "incognito" | "restricted";

export type TabEligibilityResult =
  | { eligible: true; reason: null }
  | { eligible: false; reason: TabEligibilityReason };

export function effectiveTabUrl(tab: BrowserTabSnapshot | null | undefined): string | undefined;

export function tabEligibility(
  tab: BrowserTabSnapshot | null | undefined,
  options?: { fileAccessAllowed?: boolean },
): TabEligibilityResult;

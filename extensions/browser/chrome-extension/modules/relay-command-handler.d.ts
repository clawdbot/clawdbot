import type { CreatedTabOperation, TabAccessEpoch } from "./tab-access.js";
import type { AccessibleBrowserTabSnapshot, BrowserTabSnapshot } from "./tab-eligibility.js";

export function createRelayCommandHandler(params: {
  send: (message: Record<string, unknown>) => void;
  attachDebugger: CreatedTabOperation["attachDebugger"];
  detachDebugger: (tabId: number) => Promise<void>;
  createTab: (message: Record<string, unknown>, operation: CreatedTabOperation) => Promise<void>;
  focusWindowForTab: (tab: BrowserTabSnapshot) => Promise<void>;
  scheduleTabsSync: () => void;
  captureAccess: (tabId: number, method?: string) => TabAccessEpoch;
  requireAccessibleTab: (
    tabId: number,
    epoch: TabAccessEpoch,
  ) => Promise<AccessibleBrowserTabSnapshot>;
}): (message: Record<string, unknown>, isCurrent: () => boolean) => Promise<void>;

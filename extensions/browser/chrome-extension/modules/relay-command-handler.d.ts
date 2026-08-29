import type { CreatedTabOperation, TabAccessEpoch, TabAccessPolicy } from "./tab-access.js";
import type { AccessibleBrowserTabSnapshot, BrowserTabSnapshot } from "./tab-eligibility.js";

export function createRelayCommandHandler(params: {
  send: (message: Record<string, unknown>) => void;
  attachDebugger: CreatedTabOperation["attachDebugger"];
  detachDebugger: (tabId: number) => Promise<void>;
  createTab: (message: Record<string, unknown>, operation: CreatedTabOperation) => Promise<void>;
  focusWindowForTab: (tab: BrowserTabSnapshot) => Promise<void>;
  scheduleTabsSync: () => void;
  captureAccess: (tabId: number, method?: string) => TabAccessEpoch;
  navigateTab: (
    tabId: number,
    epoch: TabAccessEpoch,
    params: Record<string, unknown>,
    isCurrent: () => boolean,
    sendCommand: (method: string, params: Record<string, unknown>) => Promise<unknown>,
  ) => Promise<unknown>;
  requireNavigatedTab: TabAccessPolicy["requireTabAfterNavigation"];
  requireAccessibleTab: (
    tabId: number,
    epoch: TabAccessEpoch,
  ) => Promise<AccessibleBrowserTabSnapshot>;
}): (message: Record<string, unknown>, isCurrent: () => boolean) => Promise<void>;

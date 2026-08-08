export function createRelayCommandHandler(params: {
  send: (message: Record<string, unknown>) => void;
  attachDebugger: (tabId: number) => Promise<unknown>;
  detachDebugger: (tabId: number) => Promise<void>;
  addTabToOpenClawGroup: (tabId: number) => Promise<void>;
  focusWindowForTab: (tab: chrome.tabs.Tab) => Promise<void>;
  scheduleTabsSync: () => void;
}): (message: Record<string, unknown>) => Promise<void>;

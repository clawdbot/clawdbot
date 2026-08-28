import type { Worker } from "playwright-core";

type ChromeEvent<T> = {
  addListener(listener: T): void;
  removeListener(listener: T): void;
};

type NavigationProbe = {
  heldReads: number;
  sawLoad: boolean;
  restore(): void;
};

declare const chrome: {
  tabs: {
    get(tabId: number): Promise<unknown>;
    onUpdated: ChromeEvent<(tabId: number, change: { url?: string }) => void>;
  };
  debugger: {
    onEvent: ChromeEvent<
      (source: { tabId?: number }, method: string, params?: { name?: string }) => void
    >;
  };
};
declare const self: { navigationProbe?: NavigationProbe };

/** Hold Chrome's real access lookup until its real load event, without delaying navigation. */
export async function holdNavigationAccessCheck(worker: Worker, url: string) {
  await worker.evaluate((destination) => {
    const originalGet = chrome.tabs.get;
    let tabId: number | undefined;
    let release = () => {};
    const loaded = new Promise<void>((resolve) => {
      release = resolve;
    });
    const onUpdated = (id: number, change: { url?: string }) => {
      if (change.url === destination) {
        tabId = id;
      }
    };
    const onEvent = (source: { tabId?: number }, method: string, params?: { name?: string }) => {
      if (source.tabId === tabId && method === "Page.lifecycleEvent" && params?.name === "load") {
        probe.sawLoad = true;
        release();
      }
    };
    const probe: NavigationProbe = {
      heldReads: 0,
      sawLoad: false,
      restore() {
        release();
        chrome.tabs.get = originalGet;
        chrome.tabs.onUpdated.removeListener(onUpdated);
        chrome.debugger.onEvent.removeListener(onEvent);
        delete self.navigationProbe;
      },
    };
    self.navigationProbe = probe;
    chrome.tabs.get = async (id) => {
      const tab = await originalGet.call(chrome.tabs, id);
      if (id === tabId && !probe.sawLoad) {
        probe.heldReads += 1;
        await loaded;
      }
      return tab;
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.debugger.onEvent.addListener(onEvent);
  }, url);

  return async () =>
    await worker.evaluate(() => {
      const probe = self.navigationProbe;
      if (!probe) {
        throw new Error("Navigation access probe missing");
      }
      const result = { heldReads: probe.heldReads, sawLoad: probe.sawLoad };
      probe.restore();
      return result;
    });
}

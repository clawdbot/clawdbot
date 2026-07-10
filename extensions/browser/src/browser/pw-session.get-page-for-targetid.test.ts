// Browser tests cover exact Playwright page selection by CDP target id.
import { chromium } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as chromeModule from "./chrome.js";
import { BrowserTabNotFoundError } from "./errors.js";
import {
  closePageByTargetIdViaPlaywright,
  closePlaywrightBrowserConnection,
  focusPageByTargetIdViaPlaywright,
  getPageForTargetId,
  listPagesViaPlaywright,
  setCdpConnectRetryDelayMsForTests,
} from "./pw-session.js";

const connectOverCdpSpy = vi.spyOn(chromium, "connectOverCDP");
const getChromeWebSocketUrlSpy = vi.spyOn(chromeModule, "getChromeWebSocketUrl");

type MockPageSpec = {
  targetId?: string;
  url?: string;
  title?: string;
  targetLookupError?: string;
};

type BrowserMockBundle = {
  browser: import("playwright-core").Browser;
  browserClose: ReturnType<typeof vi.fn>;
  pages: import("playwright-core").Page[];
  pageActions: Array<{
    bringToFront: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }>;
};

function makeBrowser(pages: MockPageSpec[]): BrowserMockBundle {
  const browserClose = vi.fn(async () => {});
  const specByPage = new Map<import("playwright-core").Page, MockPageSpec>();
  const pageActions = pages.map(() => ({
    bringToFront: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }));

  const pageObjects = pages.map((spec, index) => {
    const actions = pageActions[index]!;
    const page = {
      on: vi.fn(),
      context: () => context,
      title: vi.fn(async () => spec.title ?? spec.targetId ?? `page-${index + 1}`),
      url: vi.fn(() => spec.url ?? `https://page-${index + 1}.example`),
      bringToFront: actions.bringToFront,
      close: actions.close,
    } as unknown as import("playwright-core").Page;
    specByPage.set(page, spec);
    return page;
  });

  const context: import("playwright-core").BrowserContext = {
    pages: () => pageObjects,
    on: vi.fn(),
    newCDPSession: vi.fn(async (page: import("playwright-core").Page) => {
      const spec = specByPage.get(page);
      return {
        send: vi.fn(async (method: string) => {
          if (method !== "Target.getTargetInfo") {
            return {};
          }
          if (spec?.targetLookupError) {
            throw new Error(spec.targetLookupError);
          }
          return { targetInfo: { targetId: spec?.targetId } };
        }),
        detach: vi.fn(async () => {}),
      };
    }),
  } as unknown as import("playwright-core").BrowserContext;

  const browser = {
    contexts: () => [context],
    on: vi.fn(),
    off: vi.fn(),
    close: browserClose,
  } as unknown as import("playwright-core").Browser;

  return { browser, browserClose, pages: pageObjects, pageActions };
}

function installBrowser(pages: MockPageSpec[]): BrowserMockBundle {
  const bundle = makeBrowser(pages);
  connectOverCdpSpy.mockResolvedValue(bundle.browser);
  getChromeWebSocketUrlSpy.mockResolvedValue(null);
  return bundle;
}

afterEach(async () => {
  connectOverCdpSpy.mockReset();
  getChromeWebSocketUrlSpy.mockReset();
  setCdpConnectRetryDelayMsForTests();
  await closePlaywrightBrowserConnection().catch(() => {});
});

describe("pw-session getPageForTargetId", () => {
  it("keeps no-target selection when Playwright cannot resolve target ids", async () => {
    const { pages } = installBrowser([{ targetLookupError: "Not allowed" }]);

    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:18792" })).resolves.toBe(pages[0]);
  });

  it("rejects an explicit target when the sole page cannot expose its target id", async () => {
    const { pageActions } = installBrowser([{ targetLookupError: "Not allowed" }]);

    await expect(
      getPageForTargetId({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "NOT_A_TAB",
      }),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
    expect(pageActions[0]?.close).not.toHaveBeenCalled();
    expect(pageActions[0]?.bringToFront).not.toHaveBeenCalled();
  });

  it("does not infer target identity from duplicate URL ordering", async () => {
    installBrowser([
      { url: "https://same.example", targetLookupError: "Not allowed" },
      { url: "https://same.example", targetLookupError: "Not allowed" },
    ]);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { id: "TARGET_B", url: "https://same.example" },
          { id: "TARGET_A", url: "https://same.example" },
        ]),
        { headers: { "content-type": "application/json" } },
      ),
    );

    try {
      await expect(
        getPageForTargetId({
          cdpUrl: "http://127.0.0.1:18792",
          targetId: "TARGET_B",
        }),
      ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("matches duplicate-URL pages only by their exact CDP target id", async () => {
    const { pages } = installBrowser([
      { targetId: "TARGET_A", url: "https://same.example" },
      { targetId: "TARGET_B", url: "https://same.example" },
    ]);

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_B",
    });

    expect(resolved).toBe(pages[1]);
  });

  it("focuses and closes only the exact target when URLs are identical", async () => {
    const { pageActions } = installBrowser([
      { targetId: "TARGET_A", url: "https://same.example" },
      { targetId: "TARGET_B", url: "https://same.example" },
    ]);
    const [pageA, pageB] = pageActions;

    await focusPageByTargetIdViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_B",
    });
    await closePageByTargetIdViaPlaywright({
      cdpUrl: "http://127.0.0.1:18792",
      targetId: "TARGET_B",
    });

    expect(pageA?.bringToFront).not.toHaveBeenCalled();
    expect(pageA?.close).not.toHaveBeenCalled();
    expect(pageB?.bringToFront).toHaveBeenCalledTimes(1);
    expect(pageB?.close).toHaveBeenCalledTimes(1);
  });

  it("does not focus or close a sole unrelated page for a stale target", async () => {
    const { pageActions } = installBrowser([{ targetId: "TARGET_A" }]);
    const [page] = pageActions;

    await expect(
      focusPageByTargetIdViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "STALE_TARGET",
      }),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError);
    await expect(
      closePageByTargetIdViaPlaywright({
        cdpUrl: "http://127.0.0.1:18792",
        targetId: "STALE_TARGET",
      }),
    ).rejects.toBeInstanceOf(BrowserTabNotFoundError);

    expect(page?.bringToFront).not.toHaveBeenCalled();
    expect(page?.close).not.toHaveBeenCalled();
  });

  it("evicts a stale cached page-less browser once and succeeds on a fresh reconnect", async () => {
    const stale = makeBrowser([]);
    const fresh = makeBrowser([{ targetId: "TARGET_OK", url: "https://fresh.example" }]);

    connectOverCdpSpy.mockResolvedValueOnce(stale.browser).mockResolvedValueOnce(fresh.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9222" });

    const resolved = await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9222" });

    expect(resolved).toBe(fresh.pages[0]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("evicts a stale cached tab-selection miss once and succeeds on a fresh reconnect", async () => {
    const stale = makeBrowser([
      { targetId: "TARGET_A", url: "https://alpha.example" },
      { targetId: "TARGET_C", url: "https://charlie.example" },
    ]);
    const fresh = makeBrowser([
      { targetId: "TARGET_A", url: "https://alpha.example" },
      { targetId: "TARGET_B", url: "https://beta.example" },
    ]);

    connectOverCdpSpy.mockResolvedValueOnce(stale.browser).mockResolvedValueOnce(fresh.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await getPageForTargetId({ cdpUrl: "http://127.0.0.1:9333" });

    const resolved = await getPageForTargetId({
      cdpUrl: "http://127.0.0.1:9333",
      targetId: "TARGET_B",
    });

    expect(resolved).toBe(fresh.pages[1]);
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("fails after a single reconnect when the refreshed browser is still page-less", async () => {
    const stale = makeBrowser([]);
    const stillBroken = makeBrowser([]);

    connectOverCdpSpy
      .mockResolvedValueOnce(stale.browser)
      .mockResolvedValueOnce(stillBroken.browser);
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await listPagesViaPlaywright({ cdpUrl: "http://127.0.0.1:9444" });

    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:9444" })).rejects.toThrow(
      "No pages available in the connected browser.",
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(2);
    expect(stale.browserClose).toHaveBeenCalledTimes(1);
  });

  it("does not add an extra top-level retry for non-recoverable connect failures", async () => {
    setCdpConnectRetryDelayMsForTests(0);
    connectOverCdpSpy.mockRejectedValue(new Error("connectOverCDP exploded"));
    getChromeWebSocketUrlSpy.mockResolvedValue(null);

    await expect(getPageForTargetId({ cdpUrl: "http://127.0.0.1:9555" })).rejects.toThrow(
      "connectOverCDP exploded",
    );
    expect(connectOverCdpSpy).toHaveBeenCalledTimes(3);
  });
});

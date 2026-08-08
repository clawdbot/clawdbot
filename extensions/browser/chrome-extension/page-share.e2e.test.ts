import { createServer, type Server } from "node:http";
import { chromium, type CDPSession } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  startExtensionRelayServer,
  type ExtensionRelayHandle,
} from "../src/browser/extension-relay/relay-server.js";
import { useAutoCleanupTempDirTracker } from "../test-support.js";
import {
  copyCopilotSidepanelExtension,
  createRelayHarness,
  waitForContextExtensionId,
  waitForLoadedExtensionId,
} from "./sidepanel.e2e-support.js";

declare const chrome: {
  runtime: {
    sendMessage(message: Record<string, unknown>): Promise<{
      ok?: boolean;
      error?: string;
    }>;
  };
  storage: {
    local: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
  };
  tabGroups: {
    get(groupId: number): Promise<{ title?: string }>;
  };
  tabs: {
    get(tabId: number): Promise<{
      active?: boolean;
      groupId?: number;
      id?: number;
      url?: string;
      windowId?: number;
    }>;
    query(query: Record<string, unknown>): Promise<Array<{ id?: number; url?: string }>>;
    remove(tabId: number): Promise<void>;
    ungroup(tabIds: number[]): Promise<void>;
    update(tabId: number, update: { active: boolean }): Promise<unknown>;
  };
  windows: {
    update(windowId: number, update: { focused: boolean }): Promise<unknown>;
  };
};

const runE2E = process.env.OPENCLAW_BROWSER_COPILOT_E2E === "1";
const PAGE_SHARE_RELAY_SECRET = "c".repeat(64);
const cleanups: Array<() => Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
let nextPopupCommandId = 0;

type ChromeTarget = { targetId: string; type: string; url: string };

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup().catch(() => undefined);
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("page-share test server did not bind a TCP port");
  }
  return address.port;
}

async function evaluateToolbarPopup<T>(
  browserCdp: CDPSession,
  sessionId: string,
  expression: string,
): Promise<T> {
  const id = ++nextPopupCommandId;
  let listener: ((event: { message: string; sessionId: string }) => void) | undefined;
  const response = new Promise<Record<string, unknown>>((resolve, reject) => {
    listener = (event) => {
      if (event.sessionId !== sessionId) {
        return;
      }
      const message = JSON.parse(event.message) as {
        error?: { message?: string };
        id?: number;
        result?: Record<string, unknown>;
      };
      if (message.id !== id) {
        return;
      }
      if (message.error) {
        reject(new Error(message.error.message ?? "Chrome toolbar popup evaluation failed."));
        return;
      }
      resolve(message.result ?? {});
    };
    browserCdp.on("Target.receivedMessageFromTarget", listener);
  });

  try {
    await browserCdp.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({
        id,
        method: "Runtime.evaluate",
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    });
    const result = await response;
    const exception = result.exceptionDetails as { text?: string } | undefined;
    if (exception) {
      throw new Error(exception.text ?? "Chrome toolbar popup evaluation failed.");
    }
    return (result.result as { value?: T } | undefined)?.value as T;
  } finally {
    if (listener) {
      browserCdp.off("Target.receivedMessageFromTarget", listener);
    }
  }
}

describe.runIf(runE2E)("Chrome extension relay authorization", () => {
  it("clears an invalid persisted pairing before reconnecting after restart", async () => {
    const relay = await createRelayHarness();
    cleanups.push(relay.close);
    const unpackedExtension = await copyCopilotSidepanelExtension(tempDirs);
    const userDataDir = tempDirs.make("openclaw-extension-persisted-auth-profile-");
    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      channel: "chromium",
      headless: true,
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--enable-unsafe-extension-debugging",
        `--disable-extensions-except=${unpackedExtension}`,
        `--load-extension=${unpackedExtension}`,
      ],
    };
    const initialContext = await chromium.launchPersistentContext(userDataDir, launchOptions);
    cleanups.push(async () => await initialContext.close());
    const initialExtensionId = await waitForContextExtensionId(initialContext, unpackedExtension);
    const initialLauncher = initialContext.pages()[0] ?? (await initialContext.newPage());
    await initialLauncher.goto(`chrome-extension://${initialExtensionId}/e2e-launcher.html`);
    await initialLauncher.evaluate(
      async ({ relayPort }) =>
        await chrome.storage.local.set({
          relayUrl: `ws://127.0.0.1:${relayPort}/extension`,
          token: "legacy-unsafe-token",
          gatewayUrl: "",
          groupColor: "orange",
        }),
      { relayPort: relay.port },
    );
    await initialContext.close();

    const reloadedContext = await chromium.launchPersistentContext(userDataDir, launchOptions);
    cleanups.push(async () => await reloadedContext.close());
    const extensionId = await waitForContextExtensionId(reloadedContext, unpackedExtension);
    expect(extensionId).toBe(initialExtensionId);
    const launcher = reloadedContext.pages()[0] ?? (await reloadedContext.newPage());
    await launcher.goto(`chrome-extension://${extensionId}/e2e-launcher.html`);

    await expect
      .poll(
        async () =>
          await launcher.evaluate(
            async () => await chrome.storage.local.get(["relayUrl", "gatewayUrl", "token"]),
          ),
        { timeout: 10_000 },
      )
      .toEqual({});
    expect(
      await launcher.evaluate(async () => await chrome.runtime.sendMessage({ type: "getStatus" })),
    ).toMatchObject({ paired: false, relayUrl: "", state: "off" });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1_500);
    });
    expect(relay.connectionCount).toBe(0);
  }, 60_000);

  it("enforces pairing and current tab-group consent at the extension edge", async () => {
    const relay = await createRelayHarness();
    cleanups.push(relay.close);
    const fixture = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><title>Authorization fixture</title>");
    });
    const fixturePort = await listen(fixture);
    cleanups.push(
      async () =>
        await new Promise<void>((resolve, reject) => {
          fixture.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const unpackedExtension = await copyCopilotSidepanelExtension(tempDirs);
    const context = await chromium.launchPersistentContext(
      tempDirs.make("openclaw-extension-auth-profile-"),
      {
        channel: "chromium",
        headless: true,
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          "--enable-unsafe-extension-debugging",
          `--disable-extensions-except=${unpackedExtension}`,
          `--load-extension=${unpackedExtension}`,
        ],
      },
    );
    cleanups.push(async () => await context.close());
    const extensionId = await waitForContextExtensionId(context, unpackedExtension);
    const launcher = context.pages()[0] ?? (await context.newPage());
    await launcher.goto(`chrome-extension://${extensionId}/e2e-launcher.html`);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

    const invalidPairing = await launcher.evaluate(
      async (pairingString) => await chrome.runtime.sendMessage({ type: "pair", pairingString }),
      `ws://gateway.example.com/extension#${PAGE_SHARE_RELAY_SECRET}`,
    );
    expect(invalidPairing).toEqual({ ok: false, error: "Invalid pairing string." });
    expect(relay.connectionCount).toBe(0);

    const validPairing = await launcher.evaluate(
      async (pairingString) => await chrome.runtime.sendMessage({ type: "pair", pairingString }),
      `ws://127.0.0.1:${relay.port}/extension#${PAGE_SHARE_RELAY_SECRET}`,
    );
    expect(validPairing).toEqual({ ok: true });
    await expect.poll(() => relay.connectionCount, { timeout: 10_000 }).toBe(1);

    const created = (await relay.command({
      type: "createTab",
      url: `http://127.0.0.1:${fixturePort}/authorization`,
      background: true,
    })) as { tabId?: number };
    if (typeof created.tabId !== "number") {
      throw new Error("extension did not return a created tab id");
    }
    const tabId = created.tabId;
    const sharedTab = await worker.evaluate(async (targetTabId) => {
      const tab = await chrome.tabs.get(targetTabId);
      const group = await chrome.tabGroups.get(tab.groupId ?? -1);
      return { active: tab.active, title: group.title };
    }, tabId);
    expect(sharedTab).toEqual({ active: false, title: "OpenClaw" });
    await relay.command({ type: "attach", tabId });

    await worker.evaluate(async (targetTabId) => await chrome.tabs.ungroup([targetTabId]), tabId);
    await expect(
      relay.command({ type: "cdp", tabId, method: "Runtime.evaluate", params: {} }),
    ).rejects.toThrow(`tab ${tabId} is not in the OpenClaw tab group`);
    await expect(relay.command({ type: "activateTab", tabId })).rejects.toThrow(
      `tab ${tabId} is not in the OpenClaw tab group`,
    );
    await expect(relay.command({ type: "closeTab", tabId })).rejects.toThrow(
      `tab ${tabId} is not in the OpenClaw tab group`,
    );
    expect(
      await worker.evaluate(async (targetTabId) => await chrome.tabs.get(targetTabId), tabId),
    ).toMatchObject({ active: false, id: tabId });

    await expect(relay.command({ type: "detach", tabId })).resolves.toEqual({});
    await worker.evaluate(async (targetTabId) => await chrome.tabs.remove(targetTabId), tabId);
  }, 60_000);
});

describe.runIf(runE2E)("Chrome page sharing with a real Gateway extension relay", () => {
  it.each([
    { label: "relay disconnection", unpair: false },
    { label: "user unpair", unpair: true },
  ])("immediately reports $label instead of leaving the popup sending", async ({ unpair }) => {
    const receivedShares: Array<{ url: string; content: string }> = [];
    let releaseDelivery: () => void = () => {};
    const delivery = new Promise<void>((resolve) => {
      releaseDelivery = resolve;
    });
    const relay = await startExtensionRelayServer({
      port: 0,
      token: PAGE_SHARE_RELAY_SECRET,
      onPageShare: async (payload) => {
        receivedShares.push({ url: payload.url, content: payload.content });
        await delivery;
      },
    });
    let relayClosed = false;
    const closeRelay = async (handle: ExtensionRelayHandle) => {
      if (!relayClosed) {
        relayClosed = true;
        await handle.close();
      }
    };
    cleanups.push(async () => {
      releaseDelivery();
      await closeRelay(relay);
    });

    const fixture = createServer((_request, response) => {
      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        "<!doctype html><title>Page-share relay article</title><main>Page-share relay article body.</main>",
      );
    });
    const fixturePort = await listen(fixture);
    cleanups.push(
      async () =>
        await new Promise<void>((resolve, reject) => {
          fixture.close((error) => (error ? reject(error) : resolve()));
        }),
    );

    const unpackedExtension = await copyCopilotSidepanelExtension(tempDirs);
    const context = await chromium.launchPersistentContext(
      tempDirs.make("openclaw-page-share-disconnect-profile-"),
      {
        channel: "chromium",
        headless: true,
        // Playwright disables extensions by default, which overrides the unpacked fixture below.
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          "--enable-unsafe-extension-debugging",
          `--disable-extensions-except=${unpackedExtension}`,
          `--load-extension=${unpackedExtension}`,
        ],
      },
    );
    cleanups.push(async () => await context.close());

    const browser = context.browser();
    if (!browser) {
      throw new Error("Chromium browser connection unavailable");
    }
    const browserCdp = await browser.newBrowserCDPSession();
    const extensionId = await waitForLoadedExtensionId(browserCdp, unpackedExtension);
    const pairingPage = context.pages()[0] ?? (await context.newPage());
    await pairingPage.goto(`chrome-extension://${extensionId}/popup.html`);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

    const pairing = await pairingPage.evaluate(
      async (pairingString) => await chrome.runtime.sendMessage({ type: "pair", pairingString }),
      `ws://127.0.0.1:${relay.port}/extension#${relay.token}`,
    );
    expect(pairing).toEqual({ ok: true });
    await expect.poll(() => relay.bridge.extensionConnected, { timeout: 10_000 }).toBe(true);

    const article = await context.newPage();
    await article.goto(`http://127.0.0.1:${fixturePort}/article`);
    const articleTabId = await worker.evaluate(async (expectedUrl) => {
      const tabs = await chrome.tabs.query({});
      const articleTab = tabs.find((tab) => tab.url === expectedUrl);
      if (typeof articleTab?.id !== "number") {
        throw new Error("Chrome did not expose the page-share article tab");
      }
      return articleTab.id;
    }, article.url());

    // Headless Chromium does not establish a last-focused window from
    // Playwright page focus alone, but popup.js intentionally queries one.
    await worker.evaluate(async (tabId) => {
      const tab = await chrome.tabs.get(tabId);
      if (typeof tab.windowId !== "number") {
        throw new Error("Chrome did not expose the page-share article window");
      }
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tabId, { active: true });
    }, articleTabId);
    await article.bringToFront();
    await expect
      .poll(
        async () =>
          await worker.evaluate(async (expectedTabId) => {
            const [activeTab] = await chrome.tabs.query({
              active: true,
              lastFocusedWindow: true,
            });
            return activeTab?.id === expectedTabId;
          }, articleTabId),
        { timeout: 10_000 },
      )
      .toBe(true);
    const prior = (await browserCdp.send("Target.getTargets", {
      filter: [{}],
    })) as { targetInfos: ChromeTarget[] };
    const articleTarget = prior.targetInfos.find(
      (target) => target.type === "tab" && target.url === article.url(),
    );
    if (!articleTarget) {
      throw new Error("Chromium did not expose the actual page-share article tab target");
    }
    const priorTargetIds = new Set(prior.targetInfos.map((target) => target.targetId));

    // CDP invokes the actual toolbar action, including Chrome's activeTab
    // consent grant; navigating popup.html directly cannot grant page access.
    await browserCdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: articleTarget.targetId,
    });

    await expect
      .poll(
        async () => {
          const targets = (await browserCdp.send("Target.getTargets", {
            filter: [{}],
          })) as { targetInfos: ChromeTarget[] };
          return targets.targetInfos.find(
            (target) =>
              !priorTargetIds.has(target.targetId) &&
              target.url === `chrome-extension://${extensionId}/popup.html`,
          );
        },
        { timeout: 10_000 },
      )
      .toBeTruthy();

    const targets = (await browserCdp.send("Target.getTargets", {
      filter: [{}],
    })) as { targetInfos: ChromeTarget[] };
    const popupTarget = targets.targetInfos.find(
      (target) =>
        !priorTargetIds.has(target.targetId) &&
        target.url === `chrome-extension://${extensionId}/popup.html`,
    );
    if (!popupTarget) {
      throw new Error("Chromium did not open the actual OpenClaw toolbar popup");
    }
    const attached = (await browserCdp.send("Target.attachToTarget", {
      targetId: popupTarget.targetId,
      flatten: false,
    })) as { sessionId: string };
    await expect
      .poll(
        async () =>
          await evaluateToolbarPopup<string>(browserCdp, attached.sessionId, "document.readyState"),
        { timeout: 10_000 },
      )
      .toBe("complete");

    // Opening an action popup clears lastFocusedWindow in headless Chromium.
    // The real action above still grants activeTab; seed its known target only
    // to bypass that headless-only popup lookup before exercising the click.
    await evaluateToolbarPopup<void>(
      browserCdp,
      attached.sessionId,
      `(() => {
        const button = document.querySelector("#sendPageButton");
        button.dataset.tabId = ${JSON.stringify(String(articleTabId))};
        button.disabled = false;
        button.click();
      })()`,
    );

    await expect
      .poll(
        async () => ({
          receivedShares: receivedShares.length,
          popupStatus: await evaluateToolbarPopup<string>(
            browserCdp,
            attached.sessionId,
            'document.querySelector("#pageShareStatus")?.textContent',
          ),
        }),
        { timeout: 10_000 },
      )
      .toEqual({ receivedShares: 1, popupStatus: "Sending…" });
    expect(receivedShares[0]).toEqual({
      url: article.url(),
      content: "Page-share relay article body.",
    });

    if (unpair) {
      await evaluateToolbarPopup<void>(
        browserCdp,
        attached.sessionId,
        'document.querySelector("#unpairButton").click()',
      );
    } else {
      await closeRelay(relay);
    }

    await expect
      .poll(
        async () =>
          await evaluateToolbarPopup<string>(
            browserCdp,
            attached.sessionId,
            'document.querySelector("#pageShareStatus")?.textContent',
          ),
        { timeout: 1_500, interval: 25 },
      )
      .toBe("Browser relay disconnected before OpenClaw acknowledged the page share.");
    expect(
      await evaluateToolbarPopup<boolean>(
        browserCdp,
        attached.sessionId,
        'document.querySelector("#pageShareStatus")?.classList.contains("error")',
      ),
    ).toBe(true);
    releaseDelivery();
  });

  it("keeps a real stale-tab sharing error visible across the popup status poll", async () => {
    const relay = await startExtensionRelayServer({
      port: 0,
      token: PAGE_SHARE_RELAY_SECRET,
    });
    cleanups.push(async () => await relay.close());

    const unpackedExtension = await copyCopilotSidepanelExtension(tempDirs);
    const context = await chromium.launchPersistentContext(
      tempDirs.make("openclaw-popup-consent-profile-"),
      {
        channel: "chromium",
        headless: true,
        ignoreDefaultArgs: ["--disable-extensions"],
        args: [
          "--enable-unsafe-extension-debugging",
          `--disable-extensions-except=${unpackedExtension}`,
          `--load-extension=${unpackedExtension}`,
        ],
      },
    );
    cleanups.push(async () => await context.close());

    const browser = context.browser();
    if (!browser) {
      throw new Error("Chromium browser connection unavailable");
    }
    const browserCdp = await browser.newBrowserCDPSession();
    const extensionId = await waitForLoadedExtensionId(browserCdp, unpackedExtension);
    const pairingPage = context.pages()[0] ?? (await context.newPage());
    await pairingPage.goto(`chrome-extension://${extensionId}/popup.html`);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));

    const pairing = await pairingPage.evaluate(
      async (pairingString) => await chrome.runtime.sendMessage({ type: "pair", pairingString }),
      `ws://127.0.0.1:${relay.port}/extension#${relay.token}`,
    );
    expect(pairing).toEqual({ ok: true });
    await expect.poll(() => relay.bridge.extensionConnected, { timeout: 10_000 }).toBe(true);

    const missingTabId = 999_999_999;
    const expectedError = await worker.evaluate(async (tabId) => {
      try {
        await chrome.tabs.get(tabId);
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    }, missingTabId);
    expect(expectedError).toContain(String(missingTabId));

    const activePage = await context.newPage();
    await activePage.goto("data:text/html,<title>OpenClaw popup consent fixture</title>");
    await activePage.bringToFront();
    const prior = (await browserCdp.send("Target.getTargets", {
      filter: [{}],
    })) as { targetInfos: ChromeTarget[] };
    const activeTarget = prior.targetInfos.find(
      (target) => target.type === "tab" && target.url === activePage.url(),
    );
    if (!activeTarget) {
      throw new Error("Chromium did not expose the actual popup consent tab target");
    }
    const priorTargetIds = new Set(prior.targetInfos.map((target) => target.targetId));

    await browserCdp.send("Extensions.triggerAction", {
      id: extensionId,
      targetId: activeTarget.targetId,
    });
    await expect
      .poll(
        async () => {
          const targets = (await browserCdp.send("Target.getTargets", {
            filter: [{}],
          })) as { targetInfos: ChromeTarget[] };
          return targets.targetInfos.find(
            (target) =>
              !priorTargetIds.has(target.targetId) &&
              target.url === `chrome-extension://${extensionId}/popup.html`,
          );
        },
        { timeout: 10_000 },
      )
      .toBeTruthy();

    const targets = (await browserCdp.send("Target.getTargets", {
      filter: [{}],
    })) as { targetInfos: ChromeTarget[] };
    const target = targets.targetInfos.find(
      (candidate) =>
        !priorTargetIds.has(candidate.targetId) &&
        candidate.url === `chrome-extension://${extensionId}/popup.html`,
    );
    if (!target) {
      throw new Error("Chromium did not open the actual OpenClaw toolbar popup");
    }
    const attached = (await browserCdp.send("Target.attachToTarget", {
      targetId: target.targetId,
      flatten: false,
    })) as { sessionId: string };
    await expect
      .poll(
        async () =>
          await evaluateToolbarPopup<string>(
            browserCdp,
            attached.sessionId,
            'document.querySelector("#statusLine")?.textContent',
          ),
        { timeout: 10_000 },
      )
      .toContain("Connected");

    await evaluateToolbarPopup<void>(
      browserCdp,
      attached.sessionId,
      `(() => {
        const relayValue = document.querySelector("#relayValue");
        const button = document.querySelector("#shareButton");
        if (!relayValue || !button) throw new Error("Chrome popup action controls are missing");
        window.__openclawPopupRefreshes = 0;
        new MutationObserver(() => { window.__openclawPopupRefreshes += 1; })
          .observe(relayValue, { childList: true });
        button.dataset.tabId = ${JSON.stringify(String(missingTabId))};
        button.classList.remove("hidden");
        button.disabled = false;
        button.click();
      })()`,
    );

    await expect
      .poll(
        async () =>
          await evaluateToolbarPopup<string>(
            browserCdp,
            attached.sessionId,
            'document.querySelector("#statusLine")?.textContent',
          ),
        { timeout: 1_500, interval: 25 },
      )
      .toBe(expectedError);

    await expect
      .poll(
        async () =>
          await evaluateToolbarPopup<number>(
            browserCdp,
            attached.sessionId,
            "window.__openclawPopupRefreshes",
          ),
        { timeout: 5_000, interval: 50 },
      )
      .toBeGreaterThan(0);
    const actionRefreshes = await evaluateToolbarPopup<number>(
      browserCdp,
      attached.sessionId,
      "window.__openclawPopupRefreshes",
    );
    await expect
      .poll(
        async () =>
          await evaluateToolbarPopup<number>(
            browserCdp,
            attached.sessionId,
            "window.__openclawPopupRefreshes",
          ),
        { timeout: 5_000, interval: 50 },
      )
      .toBeGreaterThan(actionRefreshes);
    const observed = await evaluateToolbarPopup<{
      refreshes: number;
      status: string;
      visible: boolean;
    }>(
      browserCdp,
      attached.sessionId,
      `({
        refreshes: window.__openclawPopupRefreshes,
        status: document.querySelector("#statusLine")?.textContent,
        visible: document.querySelector("#statusLine")?.closest(".hidden") === null,
      })`,
    );

    expect(observed.refreshes).toBeGreaterThan(actionRefreshes);
    expect(observed.status).toBe(expectedError);
    expect(observed.visible).toBe(true);
  });
});

import { createServer, type Server } from "node:http";
import { chromium, type CDPSession } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import {
  startExtensionRelayServer,
  type ExtensionRelayHandle,
} from "../src/browser/extension-relay/relay-server.js";
import { useAutoCleanupTempDirTracker } from "../test-support.js";
import { copyCopilotSidepanelExtension } from "./sidepanel.e2e-support.js";

declare const chrome: {
  runtime: {
    sendMessage(message: Record<string, unknown>): Promise<{
      ok?: boolean;
      error?: string;
    }>;
  };
  tabs: {
    query(query: Record<string, unknown>): Promise<Array<{ id?: number; url?: string }>>;
  };
};

const runE2E = process.env.OPENCLAW_BROWSER_COPILOT_E2E === "1";
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
      token: "openclaw-autoqa-page-share-relay-placeholder",
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
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
    const extensionId = new URL(worker.url()).hostname;
    const pairingPage = context.pages()[0] ?? (await context.newPage());
    await pairingPage.goto(`chrome-extension://${extensionId}/popup.html`);

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

    await article.bringToFront();
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
          await evaluateToolbarPopup<{
            disabled: boolean;
            tabId: string | undefined;
          }>(
            browserCdp,
            attached.sessionId,
            '({ disabled: document.querySelector("#sendPageButton")?.disabled, tabId: document.querySelector("#sendPageButton")?.dataset.tabId })',
          ),
        { timeout: 10_000 },
      )
      .toEqual({ disabled: false, tabId: String(articleTabId) });

    await evaluateToolbarPopup<void>(
      browserCdp,
      attached.sessionId,
      'document.querySelector("#sendPageButton").click()',
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
});

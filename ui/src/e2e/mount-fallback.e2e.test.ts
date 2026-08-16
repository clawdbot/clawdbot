import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { pauseVirtualClock, type ControlUiE2eServer } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const indexHtmlPath = path.resolve(
  process.cwd(),
  path.basename(process.cwd()) === "ui" ? "index.html" : "ui/index.html",
);
const renderEvent = "openclaw-control-ui-rendered";
const loadCountKey = "openclaw.control-ui-e2e.mount-fallback-loads";
const renderCountKey = "openclaw.control-ui-e2e.mount-fallback-renders";
let syntheticModuleRenders = false;

async function startRegisteredElementFixture(): Promise<ControlUiE2eServer> {
  const indexHtml = await readFile(indexHtmlPath, "utf8");
  const server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
    if (requestUrl.pathname === "/src/main.ts") {
      response.setHeader("content-type", "text/javascript; charset=utf-8");
      response.end(
        syntheticModuleRenders
          ? `customElements.define("openclaw-app", class extends HTMLElement {
              connectedCallback() {
                this.textContent = "Application rendered";
                window.dispatchEvent(new Event(${JSON.stringify(renderEvent)}));
              }
            });`
          : 'customElements.define("openclaw-app", class extends HTMLElement {});',
      );
      return;
    }
    if (requestUrl.pathname === "/") {
      response.setHeader("content-type", "text/html; charset=utf-8");
      response.end(indexHtml);
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Registered-element fixture did not acquire a loopback port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

async function addLifecycleCounters(page: Page): Promise<void> {
  await page.addInitScript(
    ({ loadKey, renderedEvent, renderKey }) => {
      const loadCount = Number.parseInt(sessionStorage.getItem(loadKey) ?? "0", 10);
      sessionStorage.setItem(loadKey, String(loadCount + 1));
      window.addEventListener(renderedEvent, () => {
        const renderCount = Number.parseInt(sessionStorage.getItem(renderKey) ?? "0", 10);
        sessionStorage.setItem(renderKey, String(renderCount + 1));
      });
    },
    { loadKey: loadCountKey, renderedEvent: renderEvent, renderKey: renderCountKey },
  );
}

const registeredElementSuite = createControlUiE2eSuite({
  name: "Control UI static mount fallback E2E",
  startServer: startRegisteredElementFixture,
  startServerBeforeBrowser: true,
});

registeredElementSuite.define(() => {
  it("shows the fallback when registration never produces an application render", async () => {
    syntheticModuleRenders = false;
    await registeredElementSuite.withPage(
      { serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        await addLifecycleCounters(page);
        await page.clock.install();
        await pauseVirtualClock(page);
        await page.goto(registeredElementSuite.server.baseUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => customElements.get("openclaw-app") !== undefined);

        expect(await page.locator("openclaw-app").textContent()).toBe("");
        expect(
          await page.evaluate((key) => sessionStorage.getItem(key), renderCountKey),
        ).toBeNull();

        await page.clock.runFor(12_001);
        await page.waitForFunction((key) => sessionStorage.getItem(key) === "2", loadCountKey);
        await page.clock.runFor(12_001);

        await page.getByRole("heading", { name: "Control UI did not start" }).waitFor();
        expect(await page.getByRole("button", { name: "Try again" }).isVisible()).toBe(true);
        expect(await page.getByRole("button", { name: "Keep waiting" }).isVisible()).toBe(true);
        expect(
          await page.evaluate((key) => sessionStorage.getItem(key), renderCountKey),
        ).toBeNull();

        syntheticModuleRenders = true;
        await Promise.all([
          page.waitForNavigation({ waitUntil: "domcontentloaded" }),
          page.getByRole("button", { name: "Try again" }).click(),
        ]);
        await page.getByText("Application rendered", { exact: true }).waitFor();
        await page.clock.runFor(12_001);

        expect(await page.locator("#openclaw-mount-fallback").isHidden()).toBe(true);
        expect(await page.evaluate((key) => sessionStorage.getItem(key), renderCountKey)).toBe("1");
      },
    );
  });
});

const runtimeFailureSuite = createControlUiE2eSuite({
  name: "Control UI failed runtime mount E2E",
  startServerBeforeBrowser: true,
});

runtimeFailureSuite.define(() => {
  it("does not complete startup when application runtime creation throws", async () => {
    await runtimeFailureSuite.withPage(
      { serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        await addLifecycleCounters(page);
        await page.addInitScript(() => {
          const browserGetComputedStyle = globalThis.getComputedStyle.bind(globalThis);
          Object.defineProperty(globalThis, "getComputedStyle", {
            configurable: true,
            value: (element: Element, pseudoElement?: string | null) => {
              if (customElements.get("openclaw-app")) {
                throw new Error("forced application runtime creation failure");
              }
              return browserGetComputedStyle(element, pseudoElement);
            },
          });
        });
        await page.clock.install();
        await pauseVirtualClock(page);
        await page.goto(runtimeFailureSuite.server.baseUrl, { waitUntil: "domcontentloaded" });
        await page.waitForFunction(() => customElements.get("openclaw-app") !== undefined);

        await page.clock.runFor(12_001);
        await page.waitForFunction((key) => sessionStorage.getItem(key) === "2", loadCountKey);
        await page.clock.runFor(12_001);

        await page.getByRole("heading", { name: "Control UI did not start" }).waitFor();
        expect(
          await page.evaluate((key) => sessionStorage.getItem(key), renderCountKey),
        ).toBeNull();
      },
    );
  });
});

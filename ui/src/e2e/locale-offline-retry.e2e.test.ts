// Control UI tests prove locale chunk recovery through a real browser reconnect.
import type { BrowserContext, Page, Route } from "playwright";
import { expect, it } from "vitest";
import { SUPPORTED_LOCALES } from "../i18n/lib/registry.ts";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  startControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI offline locale retry",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const frenchLocaleModule = /\/src\/i18n\/locales\/fr\.ts(?:\?.*)?$/;

async function createContext(): Promise<BrowserContext> {
  return suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
}

async function gatewayPhase(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const app = document.querySelector("openclaw-app") as HTMLElement & {
      runtime?: { context: { gateway: { snapshot: { phase: string } } } };
    };
    return app.runtime?.context.gateway.snapshot.phase;
  });
}

async function documentMarker(page: Page): Promise<string | undefined> {
  return page.evaluate(
    () => (window as Window & { localeRetryDocumentMarker?: string }).localeRetryDocumentMarker,
  );
}

async function reconnect(page: Page, gateway: MockGatewayControls): Promise<void> {
  const socketCountBefore = await gateway.getSocketCount();
  await gateway.closeLatest(1001, "proxy idle timeout");
  await gateway.setOnline(false);
  await expect.poll(() => gatewayPhase(page)).toBe("reconnecting");
  await expect
    .poll(() => gateway.getSocketCount(), { timeout: 10_000 })
    .toBeGreaterThan(socketCountBefore);
  await gateway.setOnline(true);
  await expect.poll(() => gatewayPhase(page)).toBe("connected");
}

suite.define(() => {
  it("lazy-loads each registered locale only after the operator selects it", async () => {
    const context = await createContext();
    const page = await context.newPage();
    await installMockGateway(page);
    const requests = new Map<string, number>();
    page.on("request", (request) => {
      const match = new URL(request.url()).pathname.match(/\/src\/i18n\/locales\/([^/]+)\.ts$/);
      if (match?.[1] && match[1] !== "en" && match[1] !== "en-agents") {
        requests.set(match[1], (requests.get(match[1]) ?? 0) + 1);
      }
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      const picker = page.locator("#settings-language wa-select");
      await picker.waitFor();
      expect(requests.size).toBe(0);

      for (const locale of SUPPORTED_LOCALES.slice(1)) {
        await picker.evaluate((element, value) => {
          (element as HTMLElement & { value: string }).value = value;
          element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        }, locale);
        await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(locale);
        expect(requests.get(locale)).toBe(1);
      }
      expect(requests.size).toBe(20);
    } finally {
      await context.close();
    }
  });

  it("applies a locale whose first chunk request failed after the Gateway reconnects", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      webSocketPassthroughPrefixes: [`${controlUiBundledGatewayUrl(suite.server.baseUrl)}/?token=`],
    });
    let abortedLocaleRequests = 0;
    const abortFrenchLocale = async (route: Route) => {
      abortedLocaleRequests += 1;
      await route.abort("internetdisconnected");
    };
    await page.route(frenchLocaleModule, abortFrenchLocale);
    let documentRequestCount = 0;

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      page.on("request", (request) => {
        if (request.resourceType() === "document") {
          documentRequestCount += 1;
        }
      });
      await page.locator(".settings-row__title", { hasText: "Language" }).waitFor();
      await page.evaluate(() => {
        (window as Window & { localeRetryDocumentMarker?: string }).localeRetryDocumentMarker =
          "same-document";
      });

      const languageSelect = page
        .locator(".settings-row", { hasText: "Language" })
        .locator("wa-select");
      await languageSelect.evaluate((element) => {
        (element as HTMLElement & { value: string }).value = "fr";
        element.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
      });

      await expect.poll(() => abortedLocaleRequests).toBe(1);
      await page.locator(".settings-row__title", { hasText: "Language" }).waitFor();
      await page.locator(".settings-page").waitFor();
      expect(await documentMarker(page)).toBe("same-document");
      expect(documentRequestCount).toBe(0);

      await page.unroute(frenchLocaleModule, abortFrenchLocale);
      await reconnect(page, gateway);

      await page
        .locator(".settings-row__title", { hasText: "Langue" })
        .waitFor({ timeout: 10_000 });
      expect(await documentMarker(page)).toBeUndefined();
      expect(documentRequestCount).toBe(1);
      expect(
        await page.evaluate(() =>
          sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId"),
        ),
      ).toBe("e2e");
      await page.waitForTimeout(500);
      expect(documentRequestCount).toBe(1);
      expect(new URL(page.url()).pathname).toBe("/settings/appearance");
    } finally {
      await page.unroute(frenchLocaleModule, abortFrenchLocale);
      await context.close();
    }
  });
});

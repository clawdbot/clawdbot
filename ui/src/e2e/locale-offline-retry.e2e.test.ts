// Control UI tests prove locale chunk recovery through a real browser reconnect.
import { chromium, type Browser, type BrowserContext, type Page, type Route } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const frenchLocaleModule = /\/src\/i18n\/locales\/fr\.ts(?:\?.*)?$/;

let browser: Browser;
let server: ControlUiE2eServer;

async function createContext(): Promise<BrowserContext> {
  return browser.newContext({
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

describeControlUiE2e("Control UI offline locale retry", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not available at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("applies a locale whose first chunk request failed after the Gateway reconnects", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page);
    let abortedLocaleRequests = 0;
    const abortFrenchLocale = async (route: Route) => {
      abortedLocaleRequests += 1;
      await route.abort("internetdisconnected");
    };
    await page.route(frenchLocaleModule, abortFrenchLocale);
    let navigationCount = 0;

    try {
      const response = await page.goto(`${server.baseUrl}settings/general`);
      expect(response?.status()).toBe(200);
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) {
          navigationCount += 1;
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
      expect(navigationCount).toBe(0);

      await page.unroute(frenchLocaleModule, abortFrenchLocale);
      await reconnect(page, gateway);

      await page
        .locator(".settings-row__title", { hasText: "Langue" })
        .waitFor({ timeout: 10_000 });
      expect(await documentMarker(page)).toBeUndefined();
      expect(navigationCount).toBe(1);
      expect(
        await page.evaluate(() =>
          sessionStorage.getItem("openclaw.controlUi.staleChunkReloadBuildId"),
        ),
      ).toBe("e2e");
      await page.waitForTimeout(500);
      expect(navigationCount).toBe(1);
      expect(new URL(page.url()).pathname).toBe("/settings/general");
    } finally {
      await page.unroute(frenchLocaleModule, abortFrenchLocale);
      await context.close();
    }
  });
});

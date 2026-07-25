import path from "node:path";
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI mount recovery E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("reloads a fresh document after the initial app module is unavailable", async () => {
    const artifactDir = path.resolve(".artifacts/control-ui-e2e/mount-recovery");
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 720, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const baseUrl = new URL(server.baseUrl);
    let documentRequests = 0;
    let failedModuleRequests = 0;
    await page.route(`${baseUrl.origin}/**`, async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (request.resourceType() === "document") {
        documentRequests += 1;
        const response = await route.fetch();
        const body = (await response.text()).replace(
          'data-openclaw-mount-timeout-ms="12000"',
          'data-openclaw-mount-timeout-ms="50"',
        );
        await route.fulfill({ response, body });
        return;
      }
      if (url.pathname === "/src/main.ts" && failedModuleRequests === 0) {
        failedModuleRequests += 1;
        await route.fulfill({ body: "gateway restarting", status: 503 });
        return;
      }
      await route.continue();
    });
    await installMockGateway(page);

    try {
      expect(
        (await page.goto(`${server.baseUrl}chat`, { waitUntil: "domcontentloaded" }))?.status(),
      ).toBe(200);
      await page.locator("openclaw-app-shell").waitFor();
      await page.locator(".agent-chat__welcome").waitFor();

      expect(documentRequests).toBe(2);
      expect(failedModuleRequests).toBe(1);
      await expect.poll(() => page.url()).not.toContain("openclaw_mount_recovery");
      await page.screenshot({ path: path.join(artifactDir, "recovered-control-ui.png") });
    } finally {
      await context.close();
    }
  });
});

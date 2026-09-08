import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import { chromium, webkit, type Browser } from "playwright";
import { expect, it } from "vitest";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import {
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const useWebKit = process.env.OPENCLAW_CONTROL_UI_E2E_BROWSER === "webkit";
const proofDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();

it("replaces a silent suspended socket when its tab returns to the foreground", async () => {
  const server = await startControlUiE2eServer(undefined, { source: true });
  let browser: Browser | undefined;
  try {
    if (proofDir) {
      await mkdir(proofDir, { recursive: true });
    }
    browser = useWebKit
      ? await webkit.launch()
      : await chromium.launch({
          executablePath: resolvePlaywrightChromiumExecutablePath(chromium.executablePath()),
        });
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      ...(proofDir ? { recordVideo: { dir: proofDir } } : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page);
    await page.goto(`${server.baseUrl}chat?wake=1#latest`);
    await waitForControlUiGatewayReady(page);
    await expect.poll(() => gateway.getSocketCount()).toBe(1);
    const composer = page.locator(".agent-chat__composer-combobox textarea");
    await composer.fill("keep this draft across Safari suspension");
    const expectedUrl = page.url();
    if (proofDir) {
      await page.screenshot({ path: path.join(proofDir, "1-before-suspension.png") });
    }

    await gateway.suspendLatest();
    await page.evaluate(() => {
      const resumedAt = Date.now() + 61_000;
      Date.now = () => resumedAt;
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
      document.dispatchEvent(new Event("visibilitychange"));
    });

    await expect.poll(() => gateway.getSocketCount()).toBe(2);
    await waitForControlUiGatewayReady(page);
    await expect.poll(() => composer.inputValue()).toBe("keep this draft across Safari suspension");
    expect(page.url()).toBe(expectedUrl);
    if (proofDir) {
      await page.screenshot({ path: path.join(proofDir, "2-after-recovery.png") });
    }
    const video = page.video();
    await context.close();
    if (proofDir && video) {
      await rename(await video.path(), path.join(proofDir, "gateway-foreground-recovery.webm"));
    }
  } finally {
    await browser?.close();
    await server.close();
  }
}, 60_000);

import { mkdir } from "node:fs/promises";
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
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.resolve(
  process.cwd(),
  ".artifacts/control-ui-e2e/chat-markdown-table-interactions",
);

const wideTable = `| Service | Owner | Region | Status | Version | Deploy | Incidents | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gateway | Platform | eu-west-1 | Healthy | 2026.8.18 | Complete | 0 | Long operational note that keeps this column wide |`;

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Markdown table interactions", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    if (captureProof) {
      await mkdir(artifactDir, { recursive: true });
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("contains overflow, copies TSV, and restores focus after fullscreen", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width: 760 },
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(server.baseUrl).origin,
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [{ type: "text", text: wideTable }],
          timestamp: Date.now(),
          __openclaw: { id: "assistant-table", seq: 1 },
        },
      ],
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const bubble = page.locator('[data-entry-id="assistant-table"]');
      const shell = bubble.locator(".markdown-table");
      const viewport = shell.locator(".markdown-table__viewport");
      const copy = shell.getByRole("button", { name: "Copy table" });
      const expand = shell.getByRole("button", { name: "Expand table" });
      await shell.waitFor({ state: "visible" });
      await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-right");
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
        ),
      ).toBe(true);

      await viewport.evaluate((element) => {
        element.scrollLeft = Math.max(1, (element.scrollWidth - element.clientWidth) / 2);
        element.dispatchEvent(new Event("scroll"));
      });
      await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-left");
      await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-right");

      await copy.click();
      await expect
        .poll(() => page.evaluate(() => navigator.clipboard.readText()))
        .toContain("Service\tOwner\tRegion\tStatus\tVersion\tDeploy\tIncidents\tNotes");

      await expand.focus();
      await expand.click();
      const dialog = page.locator("dialog.markdown-table-dialog");
      await expect.poll(() => dialog.getAttribute("open")).toBe("");
      expect(await dialog.locator("table").textContent()).toContain("Gateway");
      if (captureProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "dark-fullscreen.png"),
        });
      }

      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count()).toBe(0);
      await expect
        .poll(() => expand.evaluate((element) => element === document.activeElement))
        .toBe(true);
    } finally {
      await context.close();
    }
  });
});

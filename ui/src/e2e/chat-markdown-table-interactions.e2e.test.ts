import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
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
let artifactDir: string;
beforeEach(() => {
  if (captureProof) {
    artifactDir = createControlUiE2eArtifactDir("chat-markdown-table-interactions");
  }
});

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
      const inlineTable = shell.locator("table");
      const inlineHeader = inlineTable.locator("th").first();
      const inlineCell = inlineTable.locator("td").first();
      await expand.click();
      const dialog = page.locator("dialog.markdown-table-dialog");
      await expect.poll(() => dialog.getAttribute("open")).toBe("");
      const fullscreenTable = dialog.locator("table");
      const fullscreenHeader = fullscreenTable.locator("th").first();
      const fullscreenCell = fullscreenTable.locator("td").first();
      expect(await fullscreenTable.textContent()).toContain("Gateway");
      const tableProperties = [
        "background-color",
        "border-collapse",
        "border-top-width",
        "box-shadow",
      ] as const;
      const cellProperties = [
        "background-color",
        "border-right-width",
        "border-bottom-color",
        "overflow-wrap",
        "white-space",
        "word-break",
      ] as const;
      const readStyles = async (locator: typeof inlineTable, properties: readonly string[]) =>
        locator.evaluate((element, propertyNames) => {
          const styles = getComputedStyle(element);
          return Object.fromEntries(
            propertyNames.map((property) => {
              const value = styles.getPropertyValue(property);
              if (!value) {
                throw new Error(`Missing computed value for ${property}`);
              }
              return [property, value];
            }),
          );
        }, properties);
      expect(await readStyles(fullscreenTable, tableProperties)).toEqual(
        await readStyles(inlineTable, tableProperties),
      );
      expect(await readStyles(fullscreenHeader, cellProperties)).toEqual(
        await readStyles(inlineHeader, cellProperties),
      );
      expect(await readStyles(fullscreenCell, cellProperties)).toEqual(
        await readStyles(inlineCell, cellProperties),
      );
      if (captureProof) {
        await page.screenshot({
          animations: "disabled",
          path: path.join(artifactDir, "dark-fullscreen.png"),
        });
      }

      const dialogBounds = await dialog.boundingBox();
      if (!dialogBounds) {
        throw new Error("Expanded table dialog has no layout bounds");
      }
      await page.mouse.click(
        Math.max(1, dialogBounds.x - 8),
        dialogBounds.y + Math.min(8, dialogBounds.height / 2),
      );
      await expect.poll(() => dialog.count()).toBe(0);
      await expect
        .poll(() => expand.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await expand.click();
      await expect.poll(() => dialog.getAttribute("open")).toBe("");
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

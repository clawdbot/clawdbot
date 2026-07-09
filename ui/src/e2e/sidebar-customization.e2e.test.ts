// Control UI tests cover customizable sidebar navigation and persistence.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
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

async function trimmedTextContents(locator: Locator): Promise<string[]> {
  return (await locator.allTextContents()).map((text) => text.trim());
}

async function roundedWidth(locator: Locator): Promise<number> {
  return Math.round((await locator.boundingBox())?.width ?? 0);
}

async function captureUiProof(page: Page, fileName: string) {
  if (process.env.OPENCLAW_CAPTURE_UI_PROOF !== "1") {
    return;
  }
  const artifactDir = path.join(
    process.cwd(),
    ".artifacts",
    "control-ui-e2e",
    "sidebar-customization",
  );
  await mkdir(artifactDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(artifactDir, fileName) });
}

describeControlUiE2e("Control UI sidebar customization mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("pins routes, restores defaults, and persists navigation state across reloads", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      controlUiTabs: [{ group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" }],
    });

    try {
      await page.goto(`${server.baseUrl}overview`);

      const sidebar = page.locator("openclaw-app-sidebar");
      const pinnedItems = sidebar.locator(".sidebar-nav > .nav-section__items > .nav-item");
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Overview"]);
      await expect.poll(() => sidebar.locator(".sidebar-brand").count()).toBe(1);
      await expect.poll(() => page.locator(".topbar").isVisible()).toBe(true);
      await expect.poll(() => page.locator(".dashboard-header").isVisible()).toBe(true);
      await expect.poll(() => page.locator(".topbar-brand").isVisible()).toBe(false);
      const shellNav = page.locator(".shell-nav");
      const sidebarResizer = page.getByRole("separator", { name: "Resize sidebar" });
      await expect.poll(() => roundedWidth(shellNav)).toBe(258);
      await expect.poll(() => sidebarResizer.getAttribute("aria-valuetext")).toBe("258 pixels");
      await captureUiProof(page, "00-sidebar-default-width.png");

      const resizerBounds = await sidebarResizer.boundingBox();
      if (!resizerBounds) {
        throw new Error("expected visible desktop sidebar resizer");
      }
      const resizerX = resizerBounds.x + resizerBounds.width / 2;
      const resizerY = resizerBounds.y + resizerBounds.height / 2;
      await page.mouse.move(resizerX, resizerY);
      await expect
        .poll(() =>
          page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName.toLowerCase(), {
            x: resizerX,
            y: resizerY,
          }),
        )
        .toBe("resizable-divider");
      await page.mouse.down();
      await expect.poll(() => sidebarResizer.getAttribute("class")).toContain("dragging");
      await page.mouse.move(resizerX + 100, resizerY);
      await page.mouse.up();
      await expect.poll(() => roundedWidth(shellNav)).toBe(358);
      await expect.poll(() => sidebarResizer.getAttribute("aria-valuetext")).toBe("358 pixels");
      await captureUiProof(page, "00-sidebar-resized.png");

      await page.reload();
      await expect.poll(() => roundedWidth(shellNav)).toBe(358);
      await page.setViewportSize({ height: 900, width: 1300 });
      await expect.poll(() => roundedWidth(shellNav)).toBe(358);
      await sidebarResizer.focus();
      await page.keyboard.press("Home");
      await expect.poll(() => roundedWidth(shellNav)).toBe(240);
      await page.keyboard.press("End");
      await expect.poll(() => roundedWidth(shellNav)).toBe(400);
      // Settings takes over the whole app: the regular sidebar and topbar
      // yield to the settings sidebar until "Back to app" (or Escape) exits.
      const settingsLink = sidebar.getByRole("link", { name: "Settings" });
      await expect.poll(() => settingsLink.isVisible()).toBe(true);
      await settingsLink.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/general");
      const settingsSidebar = page.locator(".settings-sidebar");
      await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
      await expect.poll(() => sidebar.isVisible()).toBe(false);
      await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);
      await expect
        .poll(() =>
          settingsSidebar
            .getByRole("link", { name: "General" })
            .first()
            .getAttribute("aria-current"),
        )
        .toBe("page");
      await captureUiProof(page, "01a-settings-takeover.png");
      await settingsSidebar.getByRole("link", { name: "Channels" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/channels");
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/overview");
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await settingsLink.click();
      await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
      await settingsSidebar.getByRole("button", { name: "Back to app" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/overview");
      await sidebar.getByRole("link", { name: "Overview" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/overview");
      await captureUiProof(page, "01-default-pinned.png");

      const moreButton = sidebar.getByRole("button", { name: "More" });
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("false");
      await moreButton.click();
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("true");
      await expect
        .poll(() =>
          trimmedTextContents(
            sidebar.locator(".nav-section--more .nav-section__items > .nav-item"),
          ),
        )
        .toContain("Logbook");
      await expect.poll(() => trimmedTextContents(pinnedItems)).not.toContain("Logbook");
      // Workboard ships disabled, so it stays hidden from navigation entirely.
      await expect
        .poll(() =>
          trimmedTextContents(
            sidebar.locator(".nav-section--more .nav-section__items > .nav-item"),
          ),
        )
        .not.toContain("Workboard");

      const customizeButton = sidebar.getByRole("button", { name: "Edit pinned items" });
      await customizeButton.click();
      const menu = sidebar.getByRole("menu", { name: "Edit pinned items" });
      await expect
        .poll(() => trimmedTextContents(menu.getByRole("menuitemcheckbox")))
        .not.toContain("Workboard");
      const overviewItem = menu.getByRole("menuitemcheckbox", { name: "Overview" });
      await expect.poll(() => overviewItem.getAttribute("aria-checked")).toBe("true");
      const usageItem = menu.getByRole("menuitemcheckbox", { name: "Usage" });
      await expect.poll(() => usageItem.getAttribute("aria-checked")).toBe("false");
      await expect
        .poll(() => overviewItem.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await captureUiProof(page, "02-customize-menu.png");

      await usageItem.click();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Overview", "Usage"]);
      await overviewItem.click();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Usage"]);
      await page.reload();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Usage"]);
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("true");
      await expect
        .poll(() =>
          trimmedTextContents(
            sidebar.locator(".nav-section--more .nav-section__items > .nav-item"),
          ),
        )
        .toContain("Overview");
      await captureUiProof(page, "03-persisted-customization.png");

      await customizeButton.click();
      await menu.getByRole("menuitem", { name: "Reset pinned items" }).click();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Overview"]);

      // The sidebar search field is the command palette entry point.
      const searchButton = sidebar.locator(".sidebar-search");
      await searchButton.click();
      const paletteInput = page.locator("#cmd-palette-input");
      await expect.poll(() => paletteInput.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => paletteInput.isVisible()).toBe(false);

      // The sidebar toggle lives in the sidebar brand row on desktop.
      const collapseButton = page.getByRole("button", { name: "Collapse sidebar" });
      await expect
        .poll(() =>
          collapseButton.evaluate((element) => Boolean(element.closest(".sidebar-brand"))),
        )
        .toBe(true);
      await collapseButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-collapsed");
      await expect
        .poll(() =>
          page
            .locator(".shell")
            .evaluate((element) => getComputedStyle(element).getPropertyValue("--shell-nav-width")),
        )
        .toBe("78px");
      await expect.poll(() => sidebarResizer.count()).toBe(0);
      // Rail mode keeps the palette entry reachable as an icon-only control.
      await expect.poll(() => searchButton.isVisible()).toBe(true);
      await page.reload();
      await expect
        .poll(() => sidebar.getByRole("button", { name: "Expand sidebar" }).isVisible())
        .toBe(true);
      await captureUiProof(page, "04-persisted-collapsed.png");

      await page.setViewportSize({ height: 900, width: 900 });
      const drawerButton = page.locator(".topbar-nav-toggle");
      await expect.poll(() => drawerButton.isVisible()).toBe(true);
      await drawerButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");
      await expect
        .poll(() =>
          sidebar.evaluate(
            (element) => (element as HTMLElement & { collapsed: boolean }).collapsed,
          ),
        )
        .toBe(false);
      await expect.poll(() => moreButton.isVisible()).toBe(true);
      await expect.poll(() => sidebarResizer.isVisible()).toBe(false);
      await expect
        .poll(() =>
          page
            .locator(".shell")
            .evaluate((element) => getComputedStyle(element).getPropertyValue("--shell-nav-width")),
        )
        .toBe("0px");
      await expect
        .poll(() =>
          page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().left),
        )
        .toBe(0);
      await expect.poll(() => page.locator(".dashboard-header").isVisible()).toBe(true);
      await expect.poll(() => page.locator(".topbar-brand").isVisible()).toBe(false);
      await captureUiProof(page, "05-expanded-tablet-drawer.png");

      // Widening with the drawer open must not leave its stale state blocking
      // the desktop collapse control.
      await page.setViewportSize({ height: 900, width: 1440 });
      await sidebar.getByRole("button", { name: "Collapse sidebar" }).click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-collapsed");
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--nav-drawer-open");
      await captureUiProof(page, "06-desktop-collapse-after-drawer.png");

      await page.setViewportSize({ height: 900, width: 900 });
      await drawerButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");
      await page.keyboard.press("Escape");
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--nav-drawer-open");
      await page.setViewportSize({ height: 852, width: 393 });
      await expect.poll(() => page.locator(".topbar-brand").isVisible()).toBe(true);
      await expect.poll(() => page.locator(".dashboard-header").isVisible()).toBe(false);
      await expect
        .poll(() =>
          page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      await captureUiProof(page, "06-mobile-brand.png");
    } finally {
      await context.close();
    }
  });

  it("shows the Workboard route when the plugin is enabled in config", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "config.get": {
          config: { plugins: { entries: { workboard: { enabled: true } } } },
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}overview`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("button", { name: "More" }).click();
      await expect
        .poll(() =>
          trimmedTextContents(
            sidebar.locator(".nav-section--more .nav-section__items > .nav-item"),
          ),
        )
        .toContain("Workboard");
    } finally {
      await context.close();
    }
  });
});

// Control UI tests cover customizable sidebar navigation and persistence.
import { mkdir, writeFile } from "node:fs/promises";
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
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "sidebar-customization",
);

async function trimmedTextContents(locator: Locator): Promise<string[]> {
  return (await locator.allTextContents()).map((text) => text.trim());
}

async function roundedWidth(locator: Locator): Promise<number> {
  return Math.round((await locator.boundingBox())?.width ?? 0);
}

async function captureUiProof(page: Page, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(uiProofArtifactDir, fileName),
  });
}

async function captureSettingsSidebarProof(sidebar: Locator, fileName: string) {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await sidebar.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, fileName),
  });
}

async function holdUiProof(page: Page, durationMs = 600) {
  if (captureUiProofEnabled) {
    await page.waitForTimeout(durationMs);
  }
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
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: captureUiProofEnabled
        ? { dir: path.join(uiProofArtifactDir, "video"), size: { height: 900, width: 1300 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const video = page.video();
    await installMockGateway(page, {
      controlUiTabs: [{ group: "control", id: "logbook", label: "Logbook", pluginId: "logbook" }],
    });

    try {
      await page.goto(`${server.baseUrl}overview`);

      const sidebar = page.locator("openclaw-app-sidebar");
      // Desktop chrome: the topbar owns brand + navigation + global actions;
      // the side panel below it is sessions-only.
      const navItems = page.locator(".topbar-nav .topnav-item");
      await expect.poll(() => page.locator(".topbar").isVisible()).toBe(true);
      await expect.poll(() => trimmedTextContents(navItems)).toEqual(["Chat", "Overview", "More"]);
      await expect.poll(() => sidebar.locator(".sidebar-brand").count()).toBe(0);
      await expect.poll(() => sidebar.locator(".sidebar-panel").count()).toBe(1);
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
      // Settings takes over the whole app: the sessions panel yields to the
      // settings sidebar until "Back to app" (or Escape) exits.
      const settingsLink = page
        .locator(".topnav-shell__actions")
        .getByRole("link", { name: "Settings" });
      await expect.poll(() => settingsLink.isVisible()).toBe(true);
      await settingsLink.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/general");
      const settingsSidebar = page.locator(".settings-sidebar");
      await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
      await expect.poll(() => sidebar.isVisible()).toBe(false);
      await expect
        .poll(() =>
          settingsSidebar
            .getByRole("link", { name: "General" })
            .first()
            .getAttribute("aria-current"),
        )
        .toBe("page");
      await captureUiProof(page, "01a-settings-takeover.png");
      await captureSettingsSidebarProof(settingsSidebar, "01a-settings-search-initial.png");
      await holdUiProof(page);
      const settingsSearch = settingsSidebar.getByRole("searchbox", {
        name: "Search settings",
      });
      const settingsLinks = settingsSidebar.locator(".settings-sidebar__item");
      const allSettingsLabels = await trimmedTextContents(settingsLinks);
      await expect.poll(() => settingsSearch.isVisible()).toBe(true);
      await expect
        .poll(() =>
          settingsSearch.evaluate((input) => {
            const firstLink = input.closest(".settings-sidebar")?.querySelector("a");
            return firstLink
              ? Boolean(input.compareDocumentPosition(firstLink) & Node.DOCUMENT_POSITION_FOLLOWING)
              : false;
          }),
        )
        .toBe(true);
      await settingsSearch.fill("  ThEmE  ");
      await expect.poll(() => trimmedTextContents(settingsLinks)).toEqual(["Appearance"]);
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/general");
      await captureSettingsSidebarProof(settingsSidebar, "01b-settings-search-filtered.png");
      await holdUiProof(page);
      await settingsSearch.fill("system");
      await expect
        .poll(() => trimmedTextContents(settingsLinks))
        .toEqual(["Infrastructure", "Worktrees", "Debug", "Logs"]);
      await captureSettingsSidebarProof(settingsSidebar, "01c-settings-search-group.png");
      await holdUiProof(page);
      await settingsSearch.fill("does-not-exist");
      await expect.poll(() => settingsLinks.count()).toBe(0);
      await expect
        .poll(() => settingsSidebar.getByRole("status").textContent())
        .toContain("No matching settings.");
      if (captureUiProofEnabled) {
        await writeFile(
          path.join(uiProofArtifactDir, "settings-search-accessibility.yml"),
          await settingsSidebar.ariaSnapshot(),
          "utf8",
        );
      }
      await captureSettingsSidebarProof(settingsSidebar, "01d-settings-search-empty.png");
      await holdUiProof(page);
      await settingsSidebar.getByRole("button", { name: "Clear settings search" }).click();
      await expect.poll(() => trimmedTextContents(settingsLinks)).toEqual(allSettingsLabels);
      await holdUiProof(page, 300);
      await settingsSearch.fill("channel");
      await captureSettingsSidebarProof(settingsSidebar, "01e-settings-search-route.png");
      await holdUiProof(page);
      await settingsSidebar.getByRole("link", { name: "Channels" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/channels");
      await expect.poll(() => settingsSearch.inputValue()).toBe("channel");
      await captureSettingsSidebarProof(settingsSidebar, "01f-settings-search-navigated.png");
      await holdUiProof(page);
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/overview");
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await settingsLink.click();
      await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
      await expect.poll(() => settingsSearch.inputValue()).toBe("");
      await captureSettingsSidebarProof(settingsSidebar, "01g-settings-search-reset.png");
      await holdUiProof(page);
      await settingsSidebar.getByRole("button", { name: "Back to app" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/overview");
      await page.locator(".topbar-nav").getByRole("link", { name: "Overview" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/overview");
      await captureUiProof(page, "01-default-pinned.png");

      const moreButton = page.locator(".topbar-nav").getByRole("button", { name: "More" });
      const moreMenu = page.locator(".topbar-menu");
      const moreMenuItems = moreMenu.locator(".topbar-menu__item");
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("false");
      await moreButton.click();
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("true");
      await expect.poll(() => trimmedTextContents(moreMenuItems)).toContain("Logbook");
      await expect.poll(() => trimmedTextContents(navItems)).not.toContain("Logbook");
      // Workboard ships disabled, so it stays hidden from navigation entirely.
      await expect.poll(() => trimmedTextContents(moreMenuItems)).not.toContain("Workboard");

      await moreMenu.getByRole("menuitem", { name: "Edit pinned items" }).click();
      const menu = page.getByRole("menu", { name: "Edit pinned items" });
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
      await expect
        .poll(() => trimmedTextContents(navItems))
        .toEqual(["Chat", "Overview", "Usage", "More"]);
      await overviewItem.click();
      await expect.poll(() => trimmedTextContents(navItems)).toEqual(["Chat", "Usage", "More"]);
      await page.reload();
      await expect.poll(() => trimmedTextContents(navItems)).toEqual(["Chat", "Usage", "More"]);
      await moreButton.click();
      await expect.poll(() => trimmedTextContents(moreMenuItems)).toContain("Overview");
      await captureUiProof(page, "03-persisted-customization.png");

      await moreMenu.getByRole("menuitem", { name: "Edit pinned items" }).click();
      await menu.getByRole("menuitem", { name: "Reset pinned items" }).click();
      await expect.poll(() => trimmedTextContents(navItems)).toEqual(["Chat", "Overview", "More"]);

      // The topbar search pill is the command palette entry point.
      const searchButton = page.locator(".topbar-search");
      await searchButton.click();
      const paletteInput = page.locator("#cmd-palette-input");
      await expect.poll(() => paletteInput.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => paletteInput.isVisible()).toBe(false);

      // Collapsing hides the sessions panel entirely; navigation stays in the
      // topbar, so no icon rail remains.
      const collapseButton = page.locator(".topbar-panel-toggle");
      await expect.poll(() => collapseButton.getAttribute("aria-label")).toBe("Collapse sidebar");
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
        .toBe("0px");
      await expect.poll(() => sidebarResizer.count()).toBe(0);
      await expect.poll(() => sidebar.isVisible()).toBe(false);
      // The palette entry stays reachable in the topbar.
      await expect.poll(() => searchButton.isVisible()).toBe(true);
      await page.reload();
      await expect
        .poll(() => page.locator(".topbar-panel-toggle").getAttribute("aria-label"))
        .toBe("Expand sidebar");
      await captureUiProof(page, "04-persisted-collapsed.png");

      await page.setViewportSize({ height: 900, width: 900 });
      const drawerButton = page.locator(".topbar-nav-toggle");
      await expect.poll(() => drawerButton.isVisible()).toBe(true);
      await drawerButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");
      // The drawer variant carries brand + nav sections + sessions.
      await expect.poll(() => sidebar.locator(".sidebar-brand").count()).toBe(1);
      await expect.poll(() => sidebar.getByRole("button", { name: "More" }).isVisible()).toBe(true);
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
      // The narrow-viewport topbar centers the brand between drawer toggle and search.
      await expect.poll(() => page.locator(".topbar-brand").isVisible()).toBe(true);
      await captureUiProof(page, "05-expanded-tablet-drawer.png");

      // Widening with the drawer open must not leave its stale state blocking
      // the desktop collapse control.
      await page.setViewportSize({ height: 900, width: 1440 });
      await page.locator(".topbar-panel-toggle").click();
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
      await expect
        .poll(() =>
          page.locator(".shell-nav").evaluate((element) => element.getBoundingClientRect().right),
        )
        .toBeLessThanOrEqual(0);
      await captureUiProof(page, "06-mobile-brand.png");
    } finally {
      await context.close();
      if (video) {
        await video.saveAs(path.join(uiProofArtifactDir, "settings-search-flow.webm"));
      }
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
      await page.locator(".topbar-nav").getByRole("button", { name: "More" }).click();
      await expect
        .poll(() => trimmedTextContents(page.locator(".topbar-menu .topbar-menu__item")))
        .toContain("Workboard");
    } finally {
      await context.close();
    }
  });
});

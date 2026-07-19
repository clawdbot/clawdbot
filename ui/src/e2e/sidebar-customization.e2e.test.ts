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

function visibleDrawerButton(page: Page) {
  return page.locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible").first();
}

async function expectLobsterOnFooterLedge(sidebar: Locator) {
  const footer = sidebar.locator(".sidebar-shell__footer");
  const sprite = footer.locator(".lobster-pet:not(.lobster-pet--passer)").first();
  await sprite.waitFor();

  await expect
    .poll(async () => {
      const [footerBox, spriteBox, borderTopWidth] = await Promise.all([
        footer.boundingBox(),
        sprite.boundingBox(),
        footer.evaluate((element) =>
          Number.parseFloat(window.getComputedStyle(element).borderTopWidth),
        ),
      ]);
      if (!footerBox || !spriteBox) {
        return null;
      }
      return {
        bottomOverlap: Math.round(spriteBox.y + spriteBox.height - footerBox.y - borderTopWidth),
        isAboveFooter: spriteBox.y < footerBox.y,
      };
    })
    .toEqual({ bottomOverlap: 3, isAboveFooter: true });
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

async function openSidebarTestPage() {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  await installMockGateway(page);
  await page.goto(`${server.baseUrl}chat`);
  await page.waitForFunction(() => Boolean(customElements.get("openclaw-lobster-pet")));
  return { context, page };
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
      methodResponses: {
        "config.get": {
          config: {},
          hash: "settings-search-e2e",
        },
        "config.schema": {
          schema: {
            type: "object",
            properties: {
              browser: {
                type: "object",
                title: "Browser",
                properties: {
                  enabled: {
                    type: "boolean",
                    title: "Enabled",
                  },
                },
              },
            },
          },
          uiHints: {},
          version: "e2e",
          generatedAt: "2026-07-12T00:00:00.000Z",
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);

      const sidebar = page.locator("openclaw-app-sidebar");
      const pinnedItems = sidebar.locator(
        '.sidebar-zone-entry[data-sidebar-entry^="route:"] > .nav-item',
      );
      await expect
        .poll(() => trimmedTextContents(pinnedItems))
        .toEqual(["OpenClaw", "Usage", "Automations", "Plugins"]);
      await expect.poll(() => sidebar.locator(".sidebar-brand").count()).toBe(1);
      // Desktop renders no topbar row: the sidebar owns navigation.
      await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);
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
      // Settings takes over the whole app: the regular sidebar yields to the
      // settings sidebar until "Back to app" (or Escape) exits. Settings opens
      // through the footer agent chip's utility menu.
      const agentChip = sidebar.getByRole("button", { name: /Agent menu/ });
      const openSettingsFromChip = async () => {
        await agentChip.click();
        await sidebar
          .locator("wa-dropdown.sidebar-agent-menu")
          .getByRole("menuitem", { exact: true, name: "Settings" })
          .click();
      };
      await expect.poll(() => agentChip.isVisible()).toBe(true);
      await openSettingsFromChip();
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
      await settingsSearch.fill("cp");
      await expect
        .poll(() =>
          trimmedTextContents(
            settingsSidebar.locator(
              ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
            ),
          ),
        )
        .toEqual(["General", "Gateway Host"]);
      await settingsSearch.fill("mcp");
      await expect
        .poll(() =>
          trimmedTextContents(
            settingsSidebar.locator(
              ".settings-sidebar__item-label, .settings-sidebar__subitem-label",
            ),
          ),
        )
        .toEqual(["MCP"]);
      await settingsSidebar.getByRole("link", { name: "MCP" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/mcp");
      await settingsSearch.fill("  ThEmE  ");
      await expect.poll(() => trimmedTextContents(settingsLinks)).toEqual(["Appearance"]);
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/mcp");
      await captureSettingsSidebarProof(settingsSidebar, "01b-settings-search-filtered.png");
      await holdUiProof(page);
      await settingsSearch.fill("system");
      await expect
        .poll(() => trimmedTextContents(settingsLinks))
        .toEqual([
          "Ask OpenClaw",
          "Approvals",
          "Infrastructure",
          "Advanced",
          "Debug",
          "Logs",
          "About",
          "General",
          "Appearance",
          "Notifications",
        ]);
      await captureSettingsSidebarProof(settingsSidebar, "01c-settings-search-group.png");
      await holdUiProof(page);
      await settingsSearch.fill("browser");
      const browserResult = settingsSidebar.getByRole("link", {
        name: "Browser",
        exact: true,
      });
      await expect.poll(() => browserResult.isVisible()).toBe(true);
      await browserResult.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/infrastructure");
      await expect.poll(() => new URL(page.url()).search).toBe("?section=browser");
      await expect.poll(() => new URL(page.url()).hash).toBe("#config-section-browser");
      await expect.poll(() => page.locator("#config-section-browser").isVisible()).toBe(true);
      await captureSettingsSidebarProof(settingsSidebar, "01c-settings-search-deep-link.png");
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
      await settingsSidebar.getByRole("link", { name: "Channels" }).first().click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/channels");
      await expect.poll(() => settingsSearch.inputValue()).toBe("channel");
      await captureSettingsSidebarProof(settingsSidebar, "01f-settings-search-navigated.png");
      await holdUiProof(page);
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/chat");
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await openSettingsFromChip();
      await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
      await expect.poll(() => settingsSearch.inputValue()).toBe("");
      await captureSettingsSidebarProof(settingsSidebar, "01g-settings-search-reset.png");
      await holdUiProof(page);
      await settingsSidebar.getByRole("link", { name: "Ask OpenClaw" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--onboarding");
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await expect
        .poll(() => page.getByRole("button", { name: "Exit setup" }).isVisible())
        .toBe(false);
      await page.goto(`${server.baseUrl}chat`);
      await captureUiProof(page, "01-default-pinned.png");

      const moreButton = sidebar.locator(".sidebar-nav__head-action");
      const moreMenu = sidebar.locator("wa-dropdown.sidebar-more-menu");
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("false");
      await moreButton.click();
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("true");
      await expect
        .poll(() => trimmedTextContents(moreMenu.getByRole("menuitem")))
        .toContain("Logbook");
      await expect.poll(() => trimmedTextContents(pinnedItems)).not.toContain("Logbook");
      // Workboard ships disabled, so it stays hidden from navigation entirely.
      await expect
        .poll(() => trimmedTextContents(moreMenu.getByRole("menuitem")))
        .not.toContain("Workboard");

      await moreMenu.getByRole("menuitem", { name: "Edit pinned items" }).click();
      const menu = sidebar.locator(
        "wa-dropdown.sidebar-customize-menu:not(.sidebar-more-menu):not(.sidebar-agent-menu)",
      );
      // The pin editor replaces the More menu in place.
      await expect.poll(() => moreMenu.count()).toBe(0);
      await expect
        .poll(() => trimmedTextContents(menu.getByRole("menuitemcheckbox")))
        .not.toContain("Workboard");
      const tasksItem = menu.getByRole("menuitemcheckbox", { name: "Tasks" });
      await expect.poll(() => tasksItem.getAttribute("aria-checked")).toBe("false");
      const custodianItem = menu.getByRole("menuitemcheckbox", { name: "OpenClaw" });
      await expect.poll(() => custodianItem.getAttribute("aria-checked")).toBe("true");
      await expect
        .poll(() => custodianItem.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await captureUiProof(page, "02-customize-menu.png");

      await custodianItem.click();
      await expect
        .poll(() => trimmedTextContents(pinnedItems))
        .toEqual(["Usage", "Automations", "Plugins"]);
      await tasksItem.click();
      await expect
        .poll(() => trimmedTextContents(pinnedItems))
        .toEqual(["Usage", "Automations", "Plugins", "Tasks"]);
      await page.reload();
      await expect
        .poll(() => trimmedTextContents(pinnedItems))
        .toEqual(["Usage", "Automations", "Plugins", "Tasks"]);
      // The More menu is transient: closed after reload, unpinned routes inside.
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("false");
      await moreButton.click();
      await expect
        .poll(() => trimmedTextContents(moreMenu.getByRole("menuitem")))
        .toContain("OpenClaw");
      await captureUiProof(page, "03-persisted-customization.png");

      await moreMenu.getByRole("menuitem", { name: "Edit pinned items" }).click();
      await menu.getByRole("menuitem", { name: "Reset pinned items" }).click();
      await expect
        .poll(() => trimmedTextContents(pinnedItems))
        .toEqual(["OpenClaw", "Usage", "Automations", "Plugins"]);

      // The sidebar search field is the command palette entry point.
      const searchButton = sidebar.locator(".sidebar-search");
      await searchButton.click();
      const paletteInput = page.locator("#cmd-palette-input");
      await expect.poll(() => paletteInput.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => paletteInput.isVisible()).toBe(false);

      // The sidebar toggle lives in the sidebar brand row on desktop.
      // Collapsing hides the sidebar entirely; a floating expand control and
      // Cmd+B bring it back (there is no icon rail).
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
        .toBe("0px");
      await expect.poll(() => sidebarResizer.count()).toBe(0);
      await expect.poll(() => sidebar.isVisible()).toBe(false);
      const navExpand = page.locator(".shell-nav-expand");
      await expect.poll(() => navExpand.isVisible()).toBe(true);
      await page.reload();
      await expect.poll(() => page.locator(".shell-nav-expand").isVisible()).toBe(true);
      await captureUiProof(page, "04-persisted-collapsed.png");
      await page.locator(".shell-nav-expand").click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--nav-collapsed");
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await collapseButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-collapsed");

      await page.setViewportSize({ height: 900, width: 900 });
      const drawerButton = visibleDrawerButton(page);
      await expect.poll(() => drawerButton.isVisible()).toBe(true);
      await drawerButton.click();
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .toContain("shell--nav-drawer-open");
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
      // Narrow Chat merges navigation controls into its title bar.
      await expect.poll(() => page.locator(".chat-pane__header").first().isVisible()).toBe(true);
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
      await expect.poll(() => page.locator(".chat-pane__header").first().isVisible()).toBe(true);
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
      await page.goto(`${server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-nav__head-action").click();
      await expect
        .poll(() =>
          trimmedTextContents(
            sidebar.locator("wa-dropdown.sidebar-more-menu").getByRole("menuitem"),
          ),
        )
        .toContain("Workboard");
    } finally {
      await context.close();
    }
  });

  it("opens the start screen from the sidebar action without carrying the active session", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      await page.goto(`${server.baseUrl}chat?session=${encodeURIComponent("agent:main:work")}`);
      await page.locator("openclaw-app-sidebar .sidebar-brand__new-thread").click();

      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await expect.poll(() => new URL(page.url()).searchParams.get("agent")).toBe("main");
      await expect.poll(() => new URL(page.url()).searchParams.has("session")).toBe(false);
      await expect.poll(() => page.locator(".new-session-page").isVisible()).toBe(true);
      await captureUiProof(page, "07-sidebar-start-screen.png");
    } finally {
      await context.close();
    }
  });

  it("passes failed run outcomes through the desktop and drawer sidebar", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: null,
            model: "gpt-5.5",
            modelProvider: "openai",
          },
          path: "",
          sessions: [
            {
              endedAt: 100,
              key: "main",
              kind: "direct",
              status: "failed",
              updatedAt: 100,
            },
          ],
          ts: 100,
        },
      },
    });

    const outcome = (locator: Locator) =>
      locator.evaluate((element) => (element as HTMLElement & { runOutcome: string }).runOutcome);

    try {
      await page.goto(`${server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      const pet = sidebar.locator(".sidebar-shell openclaw-lobster-pet");
      await expect.poll(() => pet.count()).toBe(1);
      await expect.poll(() => outcome(pet)).toBe("error");
      await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);

      await page.setViewportSize({ height: 900, width: 900 });
      const drawerButton = visibleDrawerButton(page);
      await expect.poll(() => drawerButton.isVisible()).toBe(true);
      await drawerButton.click();
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await expect.poll(() => pet.count()).toBe(1);
      await expect.poll(() => outcome(pet)).toBe("error");
    } finally {
      await context.close();
    }
  });

  it("keeps the lobster on the footer ledge across desktop and drawer layouts", async () => {
    const { context, page } = await openSidebarTestPage();

    try {
      const sidebar = page.locator("openclaw-app-sidebar");
      const pet = sidebar.locator("openclaw-lobster-pet");
      const movement = await pet.evaluate(async (element) => {
        const lobster = element as HTMLElement & {
          anchor: "bar";
          mode: "offline";
          performAct(act: "scuttle"): void;
          requestUpdate(): void;
          updateComplete: Promise<unknown>;
        };
        lobster.mode = "offline";
        await lobster.updateComplete;
        lobster.anchor = "bar";
        lobster.setAttribute("data-spot", "bar");
        lobster.requestUpdate();
        await lobster.updateComplete;

        const sprite = lobster.querySelector<HTMLElement>(".lobster-pet:not(.lobster-pet--passer)");
        const before = sprite?.style.getPropertyValue("--lob-x") ?? "";
        lobster.performAct("scuttle");
        await lobster.updateComplete;
        const after = sprite?.style.getPropertyValue("--lob-x") ?? "";
        return { after, before, spot: lobster.getAttribute("data-spot") };
      });

      expect(movement.spot).toBe("bar");
      expect(movement.after).not.toBe(movement.before);
      expect(Number.parseFloat(movement.after)).toBeGreaterThanOrEqual(18);
      expect(Number.parseFloat(movement.after)).toBeLessThanOrEqual(50);
      await expectLobsterOnFooterLedge(sidebar);
      const sprite = pet.locator(".lobster-pet:not(.lobster-pet--passer)").first();
      await sprite.dispatchEvent("pointerdown");
      await sprite.dispatchEvent("pointerup");
      await expect.poll(() => sprite.getAttribute("class")).toContain("lobster-pet--act-startle");
      await captureUiProof(page, "08-lobster-footer-ledge-desktop.png");

      await page.setViewportSize({ height: 900, width: 900 });
      await visibleDrawerButton(page).click();
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await expectLobsterOnFooterLedge(sidebar);
      await captureUiProof(page, "09-lobster-footer-ledge-drawer.png");
    } finally {
      await context.close();
    }
  });

  it("restores focus to the Pages edit button after closing the pin editor with Escape", async () => {
    const { context, page } = await openSidebarTestPage();

    try {
      const sidebar = page.locator("openclaw-app-sidebar");
      const moreButton = sidebar.locator(".sidebar-nav__head-action");
      await moreButton.click();
      await sidebar
        .locator("wa-dropdown.sidebar-more-menu")
        .getByRole("menuitem", { name: "Edit pinned items" })
        .click();
      const pinItems = sidebar
        .locator(
          "wa-dropdown.sidebar-customize-menu:not(.sidebar-more-menu):not(.sidebar-agent-menu)",
        )
        .locator('[role="menuitem"], [role="menuitemcheckbox"]');
      await page.keyboard.press("End");
      await expect
        .poll(() => pinItems.last().evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("Home");
      await expect
        .poll(() => pinItems.first().evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("Escape");

      await expect.poll(() => page.locator(".sidebar-customize-menu").count()).toBe(0);
      await expect
        .poll(() => moreButton.evaluate((element) => element === document.activeElement))
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("moves focus through the sidebar pin editor with menu keys", async () => {
    const { context, page } = await openSidebarTestPage();

    try {
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-nav__head-action").click();
      const moreMenu = sidebar.locator("wa-dropdown.sidebar-more-menu");
      await expect
        .poll(() =>
          moreMenu
            .locator('[role="menuitem"]')
            .first()
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await moreMenu.getByRole("menuitem", { name: "Edit pinned items" }).click();
      const menu = sidebar.locator(
        "wa-dropdown.sidebar-customize-menu:not(.sidebar-more-menu):not(.sidebar-agent-menu)",
      );
      const menuItems = menu.locator('[role="menuitem"], [role="menuitemcheckbox"]');
      await expect
        .poll(() =>
          menuItems.evaluateAll((items) => items.filter((item) => item.tabIndex === 0).length),
        )
        .toBe(1);
      await expect
        .poll(() => menuItems.first().evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => menuItems.nth(1).evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("End");
      await expect
        .poll(() => menuItems.last().evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => menuItems.first().evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("Tab");
      await expect.poll(() => menu.count()).toBe(0);
      const homeLink = sidebar.locator(".nav-item--home");
      await expect
        .poll(() => homeLink.evaluate((element) => element === document.activeElement))
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("shows one row per agent and reaches agent switches with menu keys", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const agentsList = {
      agents: [
        { id: "main", identity: { name: "Main" }, name: "Main" },
        { id: "research", identity: { name: "Research" }, name: "Research" },
      ],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    };
    await installMockGateway(page, {
      methodResponses: {
        "agents.list": agentsList,
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: { models: [] },
          sessionId: "control-ui-e2e-session",
          thinkingLevel: null,
        },
      },
    });

    try {
      await page.goto(`${server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("button", { name: /Agent menu/ }).click();
      const menu = sidebar.locator("wa-dropdown.sidebar-agent-menu");
      const mainSwitch = menu.getByRole("menuitemradio", { name: "Main" });
      const researchSwitch = menu.getByRole("menuitemradio", { name: "Research" });
      await expect
        .poll(() =>
          researchSwitch.evaluate(
            (element) => element.parentElement?.matches("wa-dropdown.sidebar-agent-menu") ?? false,
          ),
        )
        .toBe(true);
      await expect.poll(() => menu.getByText(/^New thread —/).count()).toBe(0);
      await expect
        .poll(() => mainSwitch.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => researchSwitch.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await captureUiProof(page, "agent-menu-without-new-session-rows.png");
      await page.keyboard.press("Enter");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/chat");
      expect(new URL(page.url()).searchParams.get("session")).toBe("agent:research:main");
    } finally {
      await context.close();
    }
  });
});

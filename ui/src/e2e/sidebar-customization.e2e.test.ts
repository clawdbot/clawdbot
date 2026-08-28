// Control UI tests cover customizable sidebar navigation and persistence.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  installMockGateway,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI sidebar customization mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const hiddenSessionCatalogsStorageKey = "openclaw:sidebar:sessions:hidden-catalogs";
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

async function setThemeMode(page: Page, mode: "dark" | "light") {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.classList.toggle("wa-light", nextMode === "light");
    root.classList.toggle("wa-dark", nextMode === "dark");
    root.style.colorScheme = nextMode;
  }, mode);
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
}

async function openSidebarTestPage() {
  const context = await suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  const page = await context.newPage();
  await installMockGateway(page);
  await page.goto(`${suite.server.baseUrl}chat`);
  await page.waitForFunction(() => Boolean(customElements.get("openclaw-lobster-pet")));
  return { context, page };
}

suite.define(() => {
  it("uses catalog labels in the hidden-section recovery rows", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await page.addInitScript(({ key, value }) => localStorage.setItem(key, JSON.stringify(value)), {
      key: hiddenSessionCatalogsStorageKey,
      value: ["claude", "offline-catalog"],
    });
    const gateway = await installMockGateway(page, {
      featureMethods: ["sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: { continueSession: true, archive: false },
              hosts: [],
            },
          ],
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}settings/appearance`);
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("sessions.catalog.list");
      const sidebarSettings = page.locator("#settings-appearance-sidebar");
      await sidebarSettings.getByRole("heading", { name: "Hidden session sections" }).waitFor();
      const recovery = sidebarSettings.locator(".settings-group", { hasText: "offline-catalog" });
      const row = recovery.locator(".settings-row", { hasText: "Claude Code" });
      await expect.poll(() => recovery.textContent()).toContain("Claude Code");
      await expect.poll(() => recovery.textContent()).toContain("offline-catalog");
      expect(await recovery.getByText("claude", { exact: true }).count()).toBe(0);

      if (captureUiProofEnabled) {
        await mkdir(uiProofArtifactDir, { recursive: true });
        await recovery.scrollIntoViewIfNeeded();
        for (const theme of ["light", "dark"] as const) {
          await setThemeMode(page, theme);
          await page.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, `after-${theme}-context.png`),
          });
          await recovery.screenshot({
            animations: "disabled",
            path: path.join(uiProofArtifactDir, `after-${theme}-rows.png`),
          });
        }
      }

      await row.getByRole("button", { name: "Show" }).click();
      await expect.poll(() => row.count()).toBe(0);
      expect(
        await page.evaluate((key) => localStorage.getItem(key), hiddenSessionCatalogsStorageKey),
      ).toBe('["offline-catalog"]');
    } finally {
      await context.close();
    }
  });

  it("pins routes, restores defaults, and persists navigation state across reloads", async () => {
    if (captureUiProofEnabled) {
      await mkdir(uiProofArtifactDir, { recursive: true });
    }
    const context = await suite.browser.newContext({
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
              tools: {
                type: "object",
                title: "Tools",
                properties: {
                  profile: {
                    type: "string",
                    description: "Controls sandbox access",
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
      await page.goto(`${suite.server.baseUrl}chat`);

      const sidebar = page.locator("openclaw-app-sidebar");
      const pinnedItems = sidebar.locator(
        '.sidebar-zone-entry[data-sidebar-entry^="route:"] > .nav-item',
      );
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Automations", "Plugins"]);
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
      // Persisted shell width is restored before the reloaded chat route commits.
      await waitForControlUiRoute(page, { pathnamePrefix: "/chat", routeId: "chat" });
      await page.setViewportSize({ height: 900, width: 1300 });
      await expect.poll(() => roundedWidth(shellNav)).toBe(358);
      await sidebarResizer.focus();
      await page.keyboard.press("Home");
      await expect.poll(() => roundedWidth(shellNav)).toBe(240);
      await page.keyboard.press("End");
      await expect.poll(() => roundedWidth(shellNav)).toBe(400);
      // Settings takes over the whole app: the regular sidebar yields to the
      // settings sidebar until "Back to app" (or Escape) exits. Settings opens
      // through the footer identity card's account utility menu.
      const identityCard = sidebar.locator(".sidebar-identity-card");
      const openSettingsFromIdentity = async () => {
        await identityCard.click();
        await sidebar
          .locator("wa-dropdown.sidebar-identity-menu")
          .getByRole("menuitem", { exact: true, name: "Settings" })
          .click();
      };
      await expect.poll(() => identityCard.isVisible()).toBe(true);
      await openSettingsFromIdentity();
      const { search: settingsSearch, sidebar: settingsSidebar } =
        await waitForControlUiSettingsTakeover(page);
      await expect
        .poll(() =>
          settingsSidebar
            .getByRole("link", { name: "Appearance" })
            .first()
            .getAttribute("aria-current"),
        )
        .toBe("page");
      await captureUiProof(page, "01a-settings-takeover.png");
      await captureSettingsSidebarProof(settingsSidebar, "01a-settings-search-initial.png");
      await holdUiProof(page);
      const settingsLinks = settingsSidebar.locator(".settings-sidebar__item");
      const allSettingsLabels = await trimmedTextContents(settingsLinks);
      expect(allSettingsLabels).not.toContain("Agent Defaults");
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
        .toEqual(["Gateway", "Gateway Host"]);
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
          "Updates",
          "About",
          "Appearance",
          "Notifications",
          "Gateway",
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
      // Browser is an advanced-tier section (#112538): search navigation
      // carries the advanced=1 reveal intent.
      await expect.poll(() => new URL(page.url()).search).toBe("?section=browser&advanced=1");
      await expect.poll(() => new URL(page.url()).hash).toBe("#config-section-browser");
      await expect.poll(() => page.locator("#config-section-browser").isVisible()).toBe(true);
      await captureSettingsSidebarProof(settingsSidebar, "01c-settings-search-deep-link.png");
      await holdUiProof(page);

      await settingsSearch.fill("session observer");
      const sidebarPreferencesResult = settingsSidebar.getByRole("link", {
        exact: true,
        name: "Sidebar",
      });
      await expect.poll(() => sidebarPreferencesResult.isVisible()).toBe(true);
      await sidebarPreferencesResult.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/appearance");
      await expect.poll(() => new URL(page.url()).search).toBe("?section=__appearance__");
      await expect.poll(() => new URL(page.url()).hash).toBe("#settings-appearance-sidebar");
      await expect
        .poll(() =>
          page
            .locator("#settings-appearance-sidebar")
            .getByRole("heading", { name: "Session observer" })
            .isVisible(),
        )
        .toBe(true);

      await settingsSearch.fill("message width");
      const chatPreferencesResult = settingsSidebar.getByRole("link", {
        exact: true,
        name: "Chat",
      });
      await expect.poll(() => chatPreferencesResult.isVisible()).toBe(true);
      await chatPreferencesResult.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/appearance");
      await expect.poll(() => new URL(page.url()).search).toBe("?section=__appearance__");
      await expect.poll(() => new URL(page.url()).hash).toBe("#settings-appearance-chat");
      await expect
        .poll(() =>
          page
            .locator("#settings-appearance-chat")
            .getByText("Message width", { exact: true })
            .isVisible(),
        )
        .toBe(true);

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
      await settingsSidebar.getByRole("link", { name: "Agents", exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents");
      const agentDefaultsRow = page.getByRole("button", {
        name: "Agent defaults Defaults every agent inherits unless overridden.",
      });
      await expect.poll(() => agentDefaultsRow.isVisible()).toBe(true);
      await agentDefaultsRow.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/ai-agents");
      await expect
        .poll(() =>
          settingsSidebar
            .getByRole("link", { name: "Agents", exact: true })
            .getAttribute("aria-current"),
        )
        .toBe("page");
      await settingsSearch.fill("sandbox access");
      const toolsResult = settingsSidebar.getByRole("link", { name: "Tools", exact: true });
      await expect.poll(() => toolsResult.isVisible()).toBe(true);
      await toolsResult.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/ai-agents");
      await expect.poll(() => new URL(page.url()).search).toBe("?section=tools&advanced=1");
      await expect.poll(() => new URL(page.url()).hash).toBe("#config-section-tools");
      await settingsSearch.fill("channel");
      await captureSettingsSidebarProof(settingsSidebar, "01e-settings-search-route.png");
      await holdUiProof(page);
      const channelsResult = settingsSidebar.getByRole("link", { name: "Channels" }).first();
      await channelsResult.click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/channels");
      await expect.poll(() => settingsSearch.inputValue()).toBe("channel");
      await captureSettingsSidebarProof(
        settingsSidebar,
        `settings-navigation-${process.env.OPENCLAW_UI_PROOF_LABEL ?? "current"}.png`,
      );
      await expect.poll(() => channelsResult.getAttribute("aria-current")).toBe("page");
      await captureSettingsSidebarProof(settingsSidebar, "01f-settings-search-navigated.png");
      await holdUiProof(page);
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath("main"));
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await openSettingsFromIdentity();
      await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
      await expect.poll(() => settingsSearch.inputValue()).toBe("");
      await captureSettingsSidebarProof(settingsSidebar, "01g-settings-search-reset.png");
      await holdUiProof(page);
      await settingsSidebar.getByRole("link", { name: "Ask OpenClaw" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/custodian");
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--onboarding");
      // Ask OpenClaw is a settings-takeover page (#111686): the settings
      // sidebar owns navigation there, not the app sidebar.
      await expect.poll(() => settingsSidebar.isVisible()).toBe(true);
      await expect.poll(() => sidebar.isVisible()).toBe(false);
      await expect
        .poll(() => page.getByRole("button", { name: "Exit setup" }).isVisible())
        .toBe(false);
      await page.goto(`${suite.server.baseUrl}chat`);
      await captureUiProof(page, "01-default-pinned.png");

      const moreButton = sidebar.locator(".sidebar-nav__head-action");
      const moreMenu = sidebar.locator("wa-dropdown.sidebar-more-menu");
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("false");
      await moreButton.click();
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("true");
      // Enabled plugin tabs render directly in the sidebar body (#111995),
      // not inside the More menu.
      await expect
        .poll(() => trimmedTextContents(moreMenu.getByRole("menuitem")))
        .not.toContain("Logbook");
      await expect
        .poll(() => trimmedTextContents(sidebar.locator(".nav-item__text")))
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
      // Ask OpenClaw moved to Settings (#111686): custodian is not a sidebar
      // nav route anymore, so the pin editor does not offer it.
      await expect
        .poll(() => menu.getByRole("menuitemcheckbox", { name: "OpenClaw" }).count())
        .toBe(0);
      await captureUiProof(page, "02-customize-menu.png");

      await tasksItem.click();
      await expect
        .poll(() => trimmedTextContents(pinnedItems))
        .toEqual(["Automations", "Plugins", "Tasks"]);
      await page.reload();
      await expect
        .poll(() => trimmedTextContents(pinnedItems))
        .toEqual(["Automations", "Plugins", "Tasks"]);
      // The More menu is transient: closed after reload, unpinned routes inside.
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("false");
      await moreButton.click();
      await expect.poll(() => moreButton.getAttribute("aria-expanded")).toBe("true");
      const editPersistedPinnedItems = moreMenu.getByRole("menuitem", {
        name: "Edit pinned items",
      });
      await expect.poll(() => editPersistedPinnedItems.isVisible()).toBe(true);
      await expect
        .poll(() => trimmedTextContents(moreMenu.getByRole("menuitem")))
        .not.toContain("Tasks");
      await captureUiProof(page, "03-persisted-customization.png");

      await editPersistedPinnedItems.click();
      await menu.getByRole("menuitem", { name: "Reset pinned items" }).click();
      await expect.poll(() => trimmedTextContents(pinnedItems)).toEqual(["Automations", "Plugins"]);

      // The shell chrome search button is the command palette entry point.
      const searchButton = page.locator(".shell-chrome-controls__search");
      await searchButton.click();
      const paletteInput = page.locator("#cmd-palette-input");
      await expect.poll(() => paletteInput.isVisible()).toBe(true);
      await page.keyboard.press("Escape");
      await expect.poll(() => paletteInput.isVisible()).toBe(false);

      // The shell chrome toggle stays visible while the desktop sidebar
      // collapses and expands (there is no icon rail).
      const collapseButton = page.getByRole("button", { name: "Collapse sidebar" });
      await expect
        .poll(() =>
          collapseButton.evaluate((element) => Boolean(element.closest(".shell-chrome-controls"))),
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
      const navExpand = page.locator(".shell-chrome-controls__nav-toggle");
      await expect.poll(() => navExpand.isVisible()).toBe(true);
      await page.reload();
      // Sidebar visibility is tab-local and intentionally not persisted; width is.
      await expect
        .poll(() => page.locator(".shell-chrome-controls__nav-toggle").isVisible())
        .toBe(true);
      await expect
        .poll(() => page.locator(".shell").getAttribute("class"))
        .not.toContain("shell--nav-collapsed");
      await expect.poll(() => sidebar.isVisible()).toBe(true);
      await expect.poll(() => roundedWidth(shellNav)).toBe(400);
      await expect.poll(() => sidebarResizer.getAttribute("aria-valuetext")).toBe("400 pixels");
      await captureUiProof(page, "04-visibility-not-persisted.png");
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
      await page.locator(".shell-chrome-controls__nav-toggle").click();
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

  it("opens the start screen from the sidebar action without carrying the active session", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        await installMockGateway(page);

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:work"));
        await page.locator("openclaw-app-sidebar .sidebar-brand__new-thread").click();

        await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
        await expect.poll(() => new URL(page.url()).searchParams.get("agent")).toBe("main");
        await expect.poll(() => new URL(page.url()).searchParams.has("session")).toBe(false);
        await expect.poll(() => page.locator(".new-session-page").isVisible()).toBe(true);
        await captureUiProof(page, "07-sidebar-start-screen.png");
      },
    );
  });

  it("moves Home activity clear of the aligned Pages editor", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
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
                  hasActiveRun: true,
                  key: "main",
                  kind: "direct",
                  status: "running",
                  updatedAt: 100,
                },
              ],
              ts: 100,
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const sidebar = page.locator("openclaw-app-sidebar");
        const home = sidebar.locator(".nav-item--home");
        await expect.poll(() => home.isVisible()).toBe(true);
        await sidebar.evaluate(async (element) => {
          const host = element as HTMLElement & {
            requestUpdate(): void;
            updateComplete: Promise<unknown>;
          };
          // The shell refreshes this callback whenever its lazy outbox runtime
          // loads. Keep the warning fixture stable until geometry is measured.
          Object.defineProperty(host, "outboxAttentionCountForSession", {
            configurable: true,
            get: () => () => 1,
            set: () => undefined,
          });
          host.requestUpdate();
          await host.updateComplete;
        });

        const activity = home.locator(".sidebar-home-session-states");
        const editor = sidebar.locator(".sidebar-nav__head-action");
        await expect.poll(() => activity.locator(".session-run-spinner").count()).toBe(1);
        await expect.poll(() => activity.locator(".session-row-badge--attention").count()).toBe(1);

        await page.mouse.move(900, 400);
        const restingActivity = await activity.boundingBox();
        expect(restingActivity).not.toBeNull();
        await sidebar.locator(".sidebar-nav").hover();
        await expect
          .poll(() => editor.evaluate((element) => getComputedStyle(element).opacity))
          .toBe("1");
        await expect
          .poll(async () => {
            const [homeBox, activityBox, editorBox] = await Promise.all([
              home.boundingBox(),
              activity.boundingBox(),
              editor.boundingBox(),
            ]);
            if (!homeBox || !activityBox || !editorBox || !restingActivity) {
              return null;
            }
            return {
              activityShift: Math.round(restingActivity.x - activityBox.x),
              centerDelta: Math.abs(
                editorBox.y + editorBox.height / 2 - (homeBox.y + homeBox.height / 2),
              ),
              gap: Math.round(editorBox.x - (activityBox.x + activityBox.width)),
            };
          })
          .toEqual({ activityShift: 25, centerDelta: 0, gap: 4 });
        await captureUiProof(page, "07-home-activity-editor.png");
      },
    );
  });

  it("keeps mobile attention in the drawer while desktop remains unchanged", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": {
              jobs: [
                {
                  id: "release-digest",
                  name: "Release digest",
                  enabled: true,
                  createdAtMs: 0,
                  updatedAtMs: 0,
                  schedule: { kind: "every", everyMs: 60_000 },
                  sessionTarget: "isolated",
                  wakeMode: "now",
                  payload: { kind: "agentTurn", message: "test" },
                  state: {
                    lastRunStatus: "error",
                    lastError: "Provider request failed",
                  },
                },
              ],
              snapshotRevision: "sidebar-mobile-attention",
              total: 1,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "models.authStatus": { providers: [], ts: 1 },
          },
        });

        await page.goto(`${suite.server.baseUrl}new`);
        await gateway.waitForRequest("cron.list");
        await gateway.emitGatewayEvent("update.available", {
          schedule: {
            autoEnabled: false,
            channel: "dev",
            install: { kind: "git", git: { status: "behind", commitsBehind: 246 } },
            target: {
              kind: "git",
              commitsBehind: 246,
              upstreamRef: "origin/main",
              upstreamSha: "9f3c21a0000000000000000000000000000000aa",
            },
          },
          updateAvailable: {
            channel: "dev",
            commitsBehind: 246,
            currentSha: "1111111111111111111111111111111111111111",
            currentVersion: "2026.8.1",
            latestVersion: "2026.8.1",
            upstreamRef: "origin/main",
            upstreamSha: "9f3c21a0000000000000000000000000000000aa",
          },
        });

        const sidebar = page.locator("openclaw-app-sidebar");
        const sidebarUpdate = sidebar.locator(
          'openclaw-sidebar-update-card[data-attention-kind="updateAvailable"]',
        );
        const sidebarAutomation = sidebar.locator('[data-attention-kind="cronFailed"]');
        await expect.poll(() => sidebar.locator(".sidebar-issues-button__count").count()).toBe(1);
        await sidebar.locator(".sidebar-issues-button").click();
        await expect.poll(() => sidebarUpdate.count()).toBe(1);
        await expect.poll(() => sidebarAutomation.count()).toBe(1);
        await captureUiProof(page, "08-desktop-attention-unchanged.png");
        await sidebar.locator(".sidebar-issues-button").click();

        await page.setViewportSize({ height: 852, width: 393 });
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--mobile-nav");
        await page.evaluate(
          () =>
            new Promise<void>((resolve) => {
              requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
            }),
        );
        const floatingKinds = await page
          .locator(".sidebar-attention--floating [data-attention-kind]")
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-attention-kind")),
          );
        await captureUiProof(page, "09-mobile-attention-closed.png");

        await visibleDrawerButton(page).click();
        await expect
          .poll(() => page.locator(".shell").getAttribute("class"))
          .toContain("shell--nav-drawer-open");
        await sidebar.locator(".sidebar-issues-button").click();
        await expect.poll(() => sidebarUpdate.isVisible()).toBe(true);
        await expect.poll(() => sidebarAutomation.isVisible()).toBe(true);
        await captureUiProof(page, "10-mobile-attention-drawer.png");

        expect(floatingKinds).toEqual([]);
      },
    );
  });

  it("passes failed run outcomes through the desktop and drawer sidebar", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
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
          locator.evaluate(
            (element) => (element as HTMLElement & { runOutcome: string }).runOutcome,
          );

        await page.goto(`${suite.server.baseUrl}chat`);
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
      },
    );
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
      // startle clears itself after LOBSTER_PET_ACT_DURATION_MS.startle (750ms), so
      // poking over one round trip and then polling for the class over another can
      // straddle the entire window on a loaded runner and never observe it. Poke and
      // read the resulting class in a single in-page step, as the unit test does.
      const startleClasses = await pet.evaluate(async (element) => {
        const lobster = element as HTMLElement & { updateComplete: Promise<unknown> };
        const target = lobster.querySelector<HTMLElement>(".lobster-pet:not(.lobster-pet--passer)");
        target?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
        target?.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
        await lobster.updateComplete;
        return target?.getAttribute("class") ?? "";
      });
      expect(startleClasses).toContain("lobster-pet--act-startle");
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
});

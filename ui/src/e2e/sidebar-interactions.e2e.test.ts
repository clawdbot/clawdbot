import { expect, it } from "vitest";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureSidebarUiProof,
  createSidebarCustomizationSuite,
  openSidebarCustomizationPage,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar interactions mocked Gateway E2E");

suite.define(() => {
  it("restores focus to the Pages edit button after closing the pin editor with Escape", async () => {
    const { context, page } = await openSidebarCustomizationPage(suite);

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
      // The pin editor installs roving focus after the outgoing More menu yields.
      await expect
        .poll(() =>
          pinItems.evaluateAll((items) => items.filter((item) => item.tabIndex === 0).length),
        )
        .toBe(1);
      await expect
        .poll(() => pinItems.first().evaluate((element) => element === document.activeElement))
        .toBe(true);
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
      await suite.closeBrowserContext(context);
    }
  });

  it("moves focus through the sidebar pin editor with menu keys", async () => {
    const { context, page } = await openSidebarCustomizationPage(suite);

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
      await suite.closeBrowserContext(context);
    }
  });

  it("shows one row per agent and reaches agent switches with menu keys", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const agentsList = {
      agents: [{ id: "main" }, { id: "research" }],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    };
    await installMockGateway(page, {
      methodResponses: {
        "agent.identity.get": {
          cases: [
            {
              match: { agentId: "main" },
              response: { agentId: "main", avatar: "", emoji: "🦞", name: "Main" },
            },
            {
              match: { agentId: "research" },
              response: {
                agentId: "research",
                avatar:
                  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
                name: "Research",
              },
            },
          ],
        },
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
      await page.goto(`${suite.server.baseUrl}chat`);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.getByRole("button", { name: /Switch agent/ }).click();
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
      await expect
        .poll(() => researchSwitch.locator("img.agent-select__avatar").getAttribute("src"))
        .toContain("data:image/png;base64,");
      await expect.poll(() => menu.getByText(/^New thread —/).count()).toBe(0);
      await expect
        .poll(() => mainSwitch.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => researchSwitch.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await captureSidebarUiProof(page, "agent-menu-without-new-session-rows.png");
      await page.keyboard.press("Enter");
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:research:main"));
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("shows a workspace identity avatar in the sidebar agent card", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const agentsList = {
      agents: [{ id: "main" }],
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
    };
    const avatar =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agent.identity.get": {
          agentId: "main",
          avatar,
          avatarStatus: "data",
          name: "Workspace Molty",
        },
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
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("agent.identity.get");
      const card = page.locator("openclaw-app-sidebar openclaw-sidebar-agent-card");
      await expect
        .poll(() => card.locator(".sidebar-agent-card__name").textContent())
        .toContain("Workspace Molty");
      const image = card.locator(".sidebar-agent-card__avatar img");
      await expect.poll(() => image.getAttribute("src")).toBe(avatar);
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBe(1);
      await captureSidebarUiProof(page, "workspace-agent-avatar.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});

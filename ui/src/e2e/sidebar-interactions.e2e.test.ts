import { expect, it } from "vitest";
import { controlUiSessionPath, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  captureSidebarUiProof,
  createSidebarCustomizationSuite,
  openSidebarCustomizationPage,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar interactions mocked Gateway E2E");

suite.define(() => {
  async function openCapabilitiesPrompt(reducedMotion: "no-preference" | "reduce") {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      reducedMotion,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page);
    await page.goto(`${suite.server.baseUrl}chat`);

    const sidebar = page.locator("openclaw-app-sidebar");
    await sidebar.locator(".sidebar-agent-card__main").click();
    await sidebar
      .locator('wa-dropdown.sidebar-agent-menu wa-dropdown-item[value="command:capabilities"]')
      .click();

    const textarea = page.locator(".agent-chat__composer-combobox > textarea");
    await expect.poll(() => textarea.inputValue()).toBe("What can you do?");
    await expect
      .poll(() => textarea.evaluate((element) => element === document.activeElement))
      .toBe(true);
    const input = textarea.locator("xpath=ancestor::*[contains(@class, 'agent-chat__input')][1]");
    await expect
      .poll(() => input.getAttribute("class"))
      .toContain("agent-chat__input--prefill-attention");
    return { context, input, page };
  }

  it("focuses and highlights the composer from the agent capabilities action", async () => {
    const { context, input, page } = await openCapabilitiesPrompt("no-preference");

    try {
      await expect
        .poll(() => input.evaluate((element) => getComputedStyle(element).animationName))
        .toBe("chat-composer-prefill-attention");
      const highlightedBackground = await input.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      await captureSidebarUiProof(page, "capabilities-composer-focus.png");
      await expect
        .poll(() => input.getAttribute("class"))
        .not.toContain("agent-chat__input--prefill-attention");
      expect(await input.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
        highlightedBackground,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps a static composer cue when reduced motion is requested", async () => {
    const { context, input, page } = await openCapabilitiesPrompt("reduce");

    try {
      await expect
        .poll(() =>
          input.evaluate((element) => {
            const style = getComputedStyle(element);
            return { animationName: style.animationName, boxShadow: style.boxShadow };
          }),
        )
        .toEqual(expect.objectContaining({ animationName: "none" }));
      await expect
        .poll(() => input.evaluate((element) => getComputedStyle(element).boxShadow))
        .not.toBe("none");
      const highlightedBackground = await input.evaluate(
        (element) => getComputedStyle(element).backgroundColor,
      );
      await captureSidebarUiProof(page, "capabilities-composer-reduced-motion.png");
      await expect
        .poll(() => input.getAttribute("class"))
        .not.toContain("agent-chat__input--prefill-attention");
      expect(await input.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
        highlightedBackground,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

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
      await expect.poll(() => menu.getByText(/^New session —/).count()).toBe(0);
      // The menu mixes avatar rows with command rows. They must share one
      // leading column, or agent labels drift right of the command labels
      // (Web Awesome's slotted-icon margin stacking on our own row gap).
      const columns = await menu.evaluate((dropdown) => {
        const left = (element: Element | null | undefined) =>
          element ? Math.round(element.getBoundingClientRect().x) : Number.NaN;
        const commandRow = dropdown.querySelector('wa-dropdown-item[value="command:new-agent"]');
        const agentRow = dropdown.querySelector(
          "wa-dropdown-item.sidebar-agent-menu__agent-switch",
        );
        return {
          agentLead: left(agentRow?.querySelector('[slot="icon"]')),
          commandLead: left(commandRow?.querySelector('[slot="icon"]')),
          agentLabel: left(agentRow?.querySelector(".agent-select__option-copy")),
          commandLabel: left(commandRow?.querySelector(".sidebar-customize-menu__text")),
        };
      });
      expect(columns.agentLead).toBeGreaterThan(0);
      expect(columns.agentLead).toBe(columns.commandLead);
      expect(columns.agentLabel).toBe(columns.commandLabel);
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

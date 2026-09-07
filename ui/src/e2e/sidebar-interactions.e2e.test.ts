import type { Page } from "playwright";
import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  controlUiSessionPath,
  controlUiSessionUrl,
  createControlUiMockBootstrapConfig,
  createControlUiMockGatewayInitScript,
  defaultControlUiFeatureMethods,
  installMockGateway,
  waitForControlUiRoute,
  type ControlUiMockGatewayScenario,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureSidebarUiProof,
  createSidebarCustomizationSuite,
  openSidebarCustomizationPage,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar interactions mocked Gateway E2E");

suite.define(() => {
  it("opens every new-session plus as a native link without creating sessions", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const agentId = "research";
    const group = "Client & ops / α";
    const catalogId = "cli-tools";
    const basePath = "/operator";
    const scenario: ControlUiMockGatewayScenario = {
      basePath,
      defaultAgentId: agentId,
      sessionKey: `agent:${agentId}:main`,
      sessionGroups: [group],
      featureMethods: [...defaultControlUiFeatureMethods, "sessions.catalog.list"],
      methodResponses: {
        "sessions.catalog.list": {
          catalogs: [
            {
              id: catalogId,
              label: "CLI tools",
              capabilities: {
                continueSession: true,
                archive: false,
                startTerminal: true,
              },
              hosts: [],
            },
          ],
        },
      },
    };
    // The opener and real browser-created tabs must receive the same Gateway fixture.
    await context.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
      route.fulfill({ json: createControlUiMockBootstrapConfig(scenario) }),
    );
    await context.addInitScript({ content: createControlUiMockGatewayInitScript(scenario) });
    const page = await context.newPage();
    const sessionCreates = (target: Page) =>
      target.evaluate(() => {
        const gateway = (
          window as Window & {
            openclawControlUiE2eGateway?: {
              findRequests: (method: string) => MockGatewayRequest[];
            };
          }
        ).openclawControlUiE2eGateway;
        if (!gateway) {
          throw new Error("Mock Gateway is not installed");
        }
        return gateway.findRequests("sessions.create");
      });

    try {
      await page.goto(
        controlUiSessionUrl(`${suite.server.baseUrl}operator/`, `agent:${agentId}:main`),
      );
      await waitForControlUiRoute(page, { routeId: "chat" });
      const composer = page.locator(".agent-chat__composer-combobox > textarea");
      const draft = "Keep this unsent conversation draft";
      await composer.fill(draft);
      const originalUrl = page.url();
      await captureSidebarUiProof(suite, page, "new-session-links-source.png");

      const actions: Array<{ selector: string; section?: string; params: Record<string, string> }> =
        [
          { selector: ".sidebar-brand__new-thread", params: { agent: agentId } },
          {
            selector: ".sidebar-session-toolbar .sidebar-new-session",
            params: { agent: agentId },
          },
          {
            selector: `[data-session-section="category:${group}"] .sidebar-new-session`,
            section: `category:${group}`,
            params: { agent: agentId, group },
          },
          {
            selector: `[data-session-section="catalog:${catalogId}"] .sidebar-session-catalog-new`,
            section: `catalog:${catalogId}`,
            params: { agent: agentId, catalog: catalogId },
          },
          { selector: ".shell-chrome-controls__new-thread", params: { agent: agentId } },
        ];
      for (const [index, action] of actions.entries()) {
        if (index === actions.length - 1) {
          await page.locator(".sidebar-brand__collapse").click();
        }
        if (action.section) {
          await page
            .locator(`[data-session-section="${action.section}"] .sidebar-recent-sessions__head`)
            .hover();
        }
        const link = page.locator(action.selector);
        await link.hover();
        const expectedUrl = new URL(`${basePath}/new`, suite.server.baseUrl);
        expectedUrl.search = new URLSearchParams(action.params).toString();
        expect(await link.getAttribute("href")).toBe(
          `${expectedUrl.pathname}${expectedUrl.search}`,
        );
        expect(
          await link.evaluate((element) => {
            const event = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
            (element.querySelector("svg") ?? element).dispatchEvent(event);
            return event.defaultPrevented;
          }),
        ).toBe(false);

        // Native tab gestures do not retain an opener, so observe the browser context.
        const [popup] = await Promise.all([
          context.waitForEvent("page"),
          index % 2 === 0
            ? link.click({ modifiers: ["ControlOrMeta"] })
            : link.click({ button: "middle" }),
        ]);
        try {
          await waitForControlUiRoute(popup, {
            routeId: "new-session",
            pathname: expectedUrl.pathname,
            search: expectedUrl.search,
          });
          await popup.locator(".new-session-page__message").waitFor({ state: "visible" });
          expect(popup.url()).toBe(expectedUrl.href);
          expect(await sessionCreates(popup)).toEqual([]);
          expect(page.url()).toBe(originalUrl);
          expect(await composer.inputValue()).toBe(draft);
          expect(await sessionCreates(page)).toEqual([]);
          if ("group" in action.params) {
            await captureSidebarUiProof(suite, popup, "new-session-links-group-tab.png");
          }
        } finally {
          await popup.close();
        }
      }

      await page.locator(".shell-chrome-controls__new-thread").click();
      await waitForControlUiRoute(page, {
        routeId: "new-session",
        pathname: `${basePath}/new`,
        search: `?agent=${agentId}`,
      });
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      expect(context.pages()).toHaveLength(1);
      expect(await sessionCreates(page)).toEqual([]);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

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

    // Record the 600ms cue before clicking; a host-side poll can arrive after it expires.
    const observedCue = await page.evaluateHandle(() => {
      const state = {
        active: false,
        background: "",
        boxShadow: "",
        duration: "",
        focused: false,
        name: "",
        value: "",
      };
      const observer = new MutationObserver(() => {
        const textarea = document.querySelector<HTMLTextAreaElement>(
          ".agent-chat__composer-combobox > textarea",
        );
        const input = textarea?.closest<HTMLElement>(".agent-chat__input");
        if (!textarea || !input?.classList.contains("agent-chat__input--prefill-attention")) {
          return;
        }
        const style = getComputedStyle(input);
        Object.assign(state, {
          active: true,
          background: style.backgroundColor,
          boxShadow: style.boxShadow,
          duration: style.animationDuration,
          focused: textarea === document.activeElement,
          name: style.animationName,
          value: textarea.value,
        });
        observer.disconnect();
      });
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
        childList: true,
        subtree: true,
      });
      return { state, disconnect: () => observer.disconnect() };
    });

    try {
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-agent-card__main").click();
      await sidebar
        .locator('wa-dropdown.sidebar-agent-menu wa-dropdown-item[value="command:capabilities"]')
        .click();

      const textarea = page.locator(".agent-chat__composer-combobox > textarea");
      const input = textarea.locator("xpath=ancestor::*[contains(@class, 'agent-chat__input')][1]");
      let cueStyle = { background: "", boxShadow: "", duration: "", name: "" };
      await expect
        .poll(async () => {
          const state = await observedCue.evaluate((cue) => cue.state);
          cueStyle = {
            background: state.background,
            boxShadow: state.boxShadow,
            duration: state.duration,
            name: state.name,
          };
          return { active: state.active, focused: state.focused, value: state.value };
        })
        .toEqual({ active: true, focused: true, value: "What can you do?" });
      await expect
        .poll(() =>
          textarea.evaluate((element: HTMLTextAreaElement) => ({
            focused: element === document.activeElement,
            value: element.value,
          })),
        )
        .toEqual({ focused: true, value: "What can you do?" });
      return { context, cueStyle, input, page };
    } finally {
      await observedCue.evaluate((cue) => cue.disconnect());
      await observedCue.dispose();
    }
  }

  it("focuses and highlights the composer from the agent capabilities action", async () => {
    const { context, cueStyle, input, page } = await openCapabilitiesPrompt("no-preference");

    try {
      expect(cueStyle).toMatchObject({
        duration: "0.6s",
        name: "chat-composer-prefill-attention",
      });
      await captureSidebarUiProof(suite, page, "capabilities-composer-focus.png");
      await expect
        .poll(() => input.getAttribute("class"))
        .not.toContain("agent-chat__input--prefill-attention");
      expect(await input.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
        cueStyle.background,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps a static composer cue when reduced motion is requested", async () => {
    const { context, cueStyle, input, page } = await openCapabilitiesPrompt("reduce");

    try {
      expect(cueStyle.name).toBe("none");
      expect(cueStyle.boxShadow).not.toBe("none");
      await captureSidebarUiProof(suite, page, "capabilities-composer-reduced-motion.png");
      await expect
        .poll(() => input.getAttribute("class"))
        .not.toContain("agent-chat__input--prefill-attention");
      expect(await input.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(
        cueStyle.background,
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
      agents: [{ id: "main" }, { id: "research" }, { id: "forge" }],
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
            {
              match: { agentId: "forge" },
              response: { agentId: "forge", avatar: "", emoji: "🔧", name: "Forge" },
            },
          ],
        },
        "agents.list": agentsList,
        "chat.startup": {
          agentsList,
          messages: [],
          metadata: { models: [] },
          sessionId: "session:agent:main:main",
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
            (element) => element.parentElement?.matches(".sidebar-agent-menu__agent-grid") ?? false,
          ),
        )
        .toBe(true);
      await expect
        .poll(() => researchSwitch.locator("img.agent-select__avatar").getAttribute("src"))
        .toContain("data:image/png;base64,");
      await expect.poll(() => menu.getByText(/^New session —/).count()).toBe(0);
      const gridLayout = await menu.evaluate((dropdown) => {
        const center = (element: Element | null | undefined) => {
          const rect = element?.getBoundingClientRect();
          return rect ? Math.round(rect.x + rect.width / 2) : Number.NaN;
        };
        const grid = dropdown.querySelector(".sidebar-agent-menu__agent-grid");
        const agentRows = [
          ...dropdown.querySelectorAll("wa-dropdown-item.sidebar-agent-menu__agent-switch"),
        ].slice(0, 3);
        return {
          columns: grid ? getComputedStyle(grid).gridTemplateColumns.split(" ").length : 0,
          bottomGap:
            grid && agentRows.length > 0
              ? Math.round(
                  grid.getBoundingClientRect().bottom -
                    Math.max(...agentRows.map((row) => row.getBoundingClientRect().bottom)),
                )
              : Number.NaN,
          widths: agentRows.map((row) => Math.round(row.getBoundingClientRect().width)),
          avatarOffsets: agentRows.map(
            (row) => center(row.querySelector(".sidebar-agent-menu__agent-avatar")) - center(row),
          ),
          labelOffsets: agentRows.map(
            (row) => center(row.querySelector(".agent-select__option-copy")) - center(row),
          ),
        };
      });
      expect(gridLayout.columns).toBe(3);
      expect(gridLayout.bottomGap).toBe(0);
      expect(new Set(gridLayout.widths).size).toBe(1);
      expect(gridLayout.avatarOffsets).toEqual([0, 0, 0]);
      expect(gridLayout.labelOffsets).toEqual([0, 0, 0]);
      await page.evaluate(() => {
        document.documentElement.style.setProperty("--control-ui-text-scale", "1.4");
      });
      await expect
        .poll(() =>
          menu.evaluate((dropdown) => {
            const grid = dropdown.querySelector(".sidebar-agent-menu__agent-grid");
            const rows = [
              ...dropdown.querySelectorAll("wa-dropdown-item.sidebar-agent-menu__agent-switch"),
            ];
            if (!grid || rows.length === 0) {
              return Number.NaN;
            }
            return Math.round(
              grid.getBoundingClientRect().bottom -
                Math.max(...rows.map((row) => row.getBoundingClientRect().bottom)),
            );
          }),
        )
        .toBe(0);
      await expect
        .poll(() => mainSwitch.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("End");
      await expect
        .poll(() =>
          menu
            .getByRole("menuitem", { name: "Agent settings" })
            .evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      await page.keyboard.press("Home");
      await expect
        .poll(() => mainSwitch.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("r");
      await expect
        .poll(() => researchSwitch.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.press("Home");
      await page.keyboard.press("ArrowDown");
      await expect
        .poll(() => researchSwitch.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await captureSidebarUiProof(suite, page, "agent-menu-without-new-session-rows.png");
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
          sessionId: "session:agent:main:main",
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
      await captureSidebarUiProof(suite, page, "workspace-agent-avatar.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});

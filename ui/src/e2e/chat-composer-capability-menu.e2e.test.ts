// Control UI E2E coverage proves the composer capability menu against a mocked Gateway.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite, tooltipTitleText } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI composer capability menu",
});

function skill(
  name: string,
  options: { blocked?: boolean; disabled?: boolean; missingDeps?: boolean } = {},
) {
  const missingBins = options.missingDeps ? ["missing-cli"] : [];
  return {
    name,
    description: `${name} skill`,
    source: "test",
    filePath: `/tmp/openclaw-e2e/skills/${name}/SKILL.md`,
    baseDir: `/tmp/openclaw-e2e/skills/${name}`,
    skillKey: name.toLowerCase(),
    always: false,
    disabled: options.disabled ?? false,
    blockedByAllowlist: options.blocked ?? false,
    eligible: missingBins.length === 0,
    requirements: { anyBins: [], bins: missingBins, env: [], config: [], os: [] },
    missing: { anyBins: [], bins: missingBins, env: [], config: [], os: [] },
    configChecks: [],
    install: [],
  };
}

function sessionsList(
  toolOverrides?: Record<string, unknown>,
  model: { id: string; provider: string } = { id: "gpt-5.5", provider: "openai" },
) {
  return {
    count: 1,
    defaults: { contextTokens: 200_000, model: model.id, modelProvider: model.provider },
    path: "",
    sessions: [
      {
        key: "agent:main:main",
        kind: "direct",
        model: model.id,
        modelProvider: model.provider,
        status: "done",
        updatedAt: Date.now(),
        ...(toolOverrides ? { toolOverrides } : {}),
      },
    ],
    ts: Date.now(),
  };
}

function configResponse(
  servers: Record<string, unknown>,
  webSearch = true,
  hash = "capability-menu-config",
) {
  const config = {
    mcp: { servers },
    plugins: webSearch
      ? {
          entries: { brave: { enabled: true, config: { webSearch: { apiKey: "redacted" } } } },
        }
      : undefined,
    tools: { web: { search: webSearch ? { provider: "brave" } : { enabled: false } } },
  };
  return {
    raw: JSON.stringify(config),
    hash,
    sourceConfig: config,
    runtimeConfig: config,
    config,
  };
}

function effectiveToolsResponse(serverName = "github") {
  return {
    agentId: "main",
    profile: "full",
    groups: [
      {
        id: "mcp",
        label: "MCP",
        source: "mcp",
        tools: [
          {
            id: "mcp_github_list_issues",
            label: "list_issues",
            description: "List issues",
            rawDescription: "List issues",
            source: "mcp",
            mcpServer: serverName,
            mcpToolName: "list-issues",
          },
          {
            id: "mcp_github_search_items_dash",
            label: "search_items",
            description: "Search items",
            rawDescription: "Search items",
            source: "mcp",
            mcpServer: serverName,
            mcpToolName: "search-items",
          },
          {
            id: "mcp_github_search_items_underscore",
            label: "search_items",
            description: "Search items",
            rawDescription: "Search items",
            source: "mcp",
            mcpServer: serverName,
            mcpToolName: "search_items",
            deniedBySession: true,
          },
          {
            id: "mcp_notion_delete_page",
            label: "delete_page",
            description: "Delete a page",
            rawDescription: "Delete a page",
            source: "mcp",
            mcpServer: "notion",
            mcpToolName: "delete_page",
          },
        ],
      },
    ],
  };
}

function undiscoveredMcpToolsResponse(serverName = "github", scoped = true) {
  return {
    agentId: "main",
    profile: "full",
    groups: [],
    notices: [
      {
        id: "mcp-not-yet-connected",
        severity: "info",
        message: `MCP servers "${serverName}" are configured but not connected for this session yet. MCP tools will appear here after an agent run discovers them.`,
        ...(scoped ? { servers: [serverName] } : {}),
      },
    ],
  };
}

async function latestToolOverrides(gateway: MockGatewayControls) {
  const requests = await gateway.getRequests("sessions.patch");
  return (requests.at(-1)?.params as { toolOverrides?: unknown } | undefined)?.toolOverrides;
}

function configPatchRaw(request: { params?: unknown }) {
  const params = request.params as { raw?: unknown } | undefined;
  if (typeof params?.raw !== "string") {
    throw new Error("Expected config.patch raw JSON");
  }
  return JSON.parse(params.raw) as Record<string, unknown>;
}

async function openMenu(page: Page) {
  const composer = page.locator(".agent-chat__input");
  const dropdown = composer.locator("wa-dropdown.agent-chat__capability-menu");
  const skills = composer.getByRole("menuitem", { name: "Skills" });
  const isOpen = await dropdown.evaluate((node) => (node as HTMLElement & { open: boolean }).open);
  if (!isOpen) {
    await composer.getByRole("button", { name: "Add attachment" }).click();
  }
  await expect
    .poll(async () => {
      const open = await dropdown.evaluate(
        (node) => (node as HTMLElement & { open: boolean }).open,
      );
      return open && (await skills.isVisible());
    })
    .toBe(true);
  return composer;
}

function webSearchItem(menu: import("playwright").Locator) {
  return menu.locator('wa-dropdown-item[value="toggle-web-search"]');
}

suite.define(() => {
  it("renders the root stack, proxies attachments, patches sparse overrides, and clears the pill", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse({
            github: { url: "https://mcp.example.test", enabled: true },
            notion: { command: "notion-mcp", enabled: false },
          }),
          "sessions.list": sessionsList({
            mcpServers: { github: false },
            mcpToolsDeny: { notion: ["delete_page"] },
            skills: { docs: false },
            webSearch: false,
          }),
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: [
              skill("Docs"),
              skill("Deploy", { disabled: true }),
              skill("Broken", { missingDeps: true }),
              skill("Private", { blocked: true }),
            ],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const attachTrigger = page.getByRole("button", { name: "Add attachment" });
      await expect
        .poll(() => attachTrigger.getAttribute("class"))
        .toContain("agent-chat__input-btn--has-overrides");

      let composer = await openMenu(page);
      const dropdown = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await expect.poll(() => dropdown.getAttribute("data-view")).toBe("root");
      await expect
        .poll(() => dropdown.getByRole("menuitem").allTextContents())
        .toEqual(
          expect.arrayContaining([
            expect.stringContaining("Take photo"),
            expect.stringContaining("Photo"),
            expect.stringContaining("File"),
            expect.stringContaining("Skills"),
            expect.stringContaining("Connectors"),
            expect.stringContaining("Manage plugins"),
          ]),
        );
      const clearOverrides = dropdown.getByRole("menuitem", { name: /4 overrides/ });
      await expect.poll(() => clearOverrides.isVisible()).toBe(true);
      await expect.poll(() => webSearchItem(dropdown).isVisible()).toBe(true);
      const skillsRoot = dropdown.getByRole("menuitem", { name: /^Skills/ });
      await skillsRoot.focus();
      await skillsRoot.evaluate((item) => {
        item
          .closest("wa-dropdown")
          ?.dispatchEvent(new CustomEvent("wa-select", { bubbles: true, detail: { item } }));
      });
      await expect.poll(() => dropdown.getAttribute("data-view")).toBe("skills");
      await dropdown.getByRole("menuitem", { name: "Back" }).click();
      await expect.poll(() => dropdown.getAttribute("data-view")).toBe("root");
      await expect
        .poll(() => dropdown.locator("wa-dropdown-item:focus").textContent())
        .toContain("Take photo");
      await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>(".agent-chat__file-input");
        if (!input) {
          throw new Error("file input missing");
        }
        input.click = () => {
          input.dataset.proxied = "true";
        };
      });
      await dropdown.getByRole("menuitem", { name: "File", exact: true }).click();
      await expect
        .poll(() => page.locator(".agent-chat__file-input").getAttribute("data-proxied"))
        .toBe("true");

      composer = await openMenu(page);
      const reopenedMenu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await reopenedMenu.locator('wa-dropdown-item[value="clear-overrides"]').click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual(null);
      await expect
        .poll(() => attachTrigger.getAttribute("class"))
        .not.toContain("agent-chat__input-btn--has-overrides");

      composer = await openMenu(page);
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Skills/ }).click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("skills");
      const docs = menu.getByRole("menuitem", { name: /^Docs/ });
      const broken = menu.getByRole("menuitem", { name: /Broken.*deps missing/ });
      const blocked = menu.getByRole("menuitem", {
        name: /Private.*not available for this agent/,
      });
      await expect.poll(() => broken.isDisabled()).toBe(true);
      await expect.poll(() => blocked.isDisabled()).toBe(true);
      await docs.click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual({ skills: { docs: false } });
      await docs.click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual({});

      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("connectors");
      const github = menu.getByRole("menuitem", { name: /^github/ });
      await github.click();
      await expect
        .poll(() => latestToolOverrides(gateway))
        .toEqual({
          mcpServers: { github: false },
        });
      await github.click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual({});
      await expect
        .poll(() => menu.getByRole("menuitem", { name: "Browse connectors" }).isDisabled())
        .toBe(false);
      await expect
        .poll(() => menu.getByRole("menuitem", { name: /Add MCP server/ }).isDisabled())
        .toBe(false);

      await menu.getByRole("menuitem", { name: "Back" }).click();
      const webSearch = webSearchItem(menu);
      await expect
        .poll(() =>
          webSearch.evaluate((node) => (node as HTMLElement & { checked: boolean }).checked),
        )
        .toBe(true);
      await webSearchItem(menu).click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual({ webSearch: false });
      await expect
        .poll(() =>
          webSearch.evaluate((node) => (node as HTMLElement & { checked: boolean }).checked),
        )
        .toBe(false);
      await webSearchItem(menu).click();
      await expect.poll(() => latestToolOverrides(gateway)).toEqual({});
      await expect
        .poll(() =>
          webSearch.evaluate((node) => (node as HTMLElement & { checked: boolean }).checked),
        )
        .toBe(true);

      const themeBackgrounds: string[] = [];
      for (const mode of ["dark", "light"] as const) {
        themeBackgrounds.push(
          await menu.evaluate((node, nextMode) => {
            document.documentElement.dataset.themeMode = nextMode;
            const surface = node.shadowRoot?.querySelector('[part="menu"]');
            return surface ? getComputedStyle(surface).backgroundColor : "";
          }, mode),
        );
      }
      expect(themeBackgrounds[0]).not.toBe("");
      expect(themeBackgrounds[1]).not.toBe("");
      expect(themeBackgrounds[0]).not.toBe(themeBackgrounds[1]);
    });
  });

  it("shows per-connector tool access and preserves raw MCP tool identity", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.patch", "tools.effective"],
        methodResponses: {
          "config.get": configResponse({
            github: { url: "https://mcp.example.test", enabled: true },
            notion: { command: "notion-mcp", enabled: true },
          }),
          "sessions.list": sessionsList({
            mcpToolsDeny: { github: ["search_items"] },
          }),
          "tools.effective": effectiveToolsResponse(),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = await openMenu(page);
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).first().click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("tools:github");
      await expect.poll(() => menu.getByText("2 of 3 tools on").isVisible()).toBe(true);
      await expect.poll(() => menu.getByRole("menuitem", { name: "delete_page" }).count()).toBe(0);

      const toolRows = menu.locator('wa-dropdown-item[value^="mcp-tool:"]');
      const rawToolNames = toolRows.locator(
        ".agent-chat__capability-menu-label > span:first-child",
      );
      await expect
        .poll(() => rawToolNames.allTextContents())
        .toEqual(["list-issues", "search-items", "search_items"]);
      await expect
        .poll(async () => [
          await rawToolNames.nth(1).isVisible(),
          await rawToolNames.nth(2).isVisible(),
        ])
        .toEqual([true, true]);
      await expect
        .poll(() =>
          toolRows
            .nth(2)
            .locator("wa-switch")
            .evaluate((node) => (node as HTMLElement & { checked: boolean }).checked),
        )
        .toBe(false);

      await gateway.deferNext("tools.effective");
      await gateway.setMethodResponse(
        "sessions.list",
        sessionsList(
          { mcpToolsDeny: { github: ["search_items"] } },
          { id: "gpt-5.6", provider: "openai" },
        ),
      );
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey: "agent:main:main" });
      await expect.poll(async () => (await gateway.getRequests("tools.effective")).length).toBe(2);
      await expect.poll(() => menu.getByText("Loading tools…").isVisible()).toBe(true);
      await gateway.resolveDeferred("tools.effective", effectiveToolsResponse());
      await expect
        .poll(() => rawToolNames.allTextContents())
        .toEqual(["list-issues", "search-items", "search_items"]);

      await toolRows.nth(1).click();
      await expect
        .poll(() => latestToolOverrides(gateway))
        .toEqual({ mcpToolsDeny: { github: ["search-items", "search_items"] } });
      await expect.poll(() => menu.getAttribute("data-view")).toBe("tools:github");

      await menu.getByRole("menuitem", { name: "Back" }).click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("connectors");
    });
  });

  it('renders tool access for a server named "constructor"', async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "tools.effective"],
        methodResponses: {
          "config.get": configResponse({
            constructor: { url: "https://mcp.example.test", enabled: true },
          }),
          "sessions.list": sessionsList({
            mcpToolsDeny: { github: ["search_items"] },
          }),
          "tools.effective": effectiveToolsResponse("constructor"),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = await openMenu(page);
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).click();

      await expect.poll(() => menu.getAttribute("data-view")).toBe("tools:constructor");
      await expect.poll(() => menu.getByText("3 of 3 tools on").isVisible()).toBe(true);
      await expect.poll(() => menu.locator('wa-dropdown-item[value^="mcp-tool:"]').count()).toBe(3);
    });
  });

  it("scopes effective-tools discovery notices to their connector", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "tools.effective"],
        methodResponses: {
          "config.get": configResponse({
            github: { url: "https://mcp.example.test", enabled: true },
            notion: { command: "notion-mcp", enabled: true },
          }),
          "sessions.list": sessionsList(),
          "tools.effective": undiscoveredMcpToolsResponse(),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = await openMenu(page);
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).first().click();

      await expect.poll(() => menu.getAttribute("data-view")).toBe("tools:github");
      await expect
        .poll(() =>
          menu
            .getByText("MCP tools will appear here after an agent run discovers them.")
            .isVisible(),
        )
        .toBe(true);
      await expect
        .poll(() => menu.getByText("No tools available for this connector.").count())
        .toBe(0);
      await expect.poll(() => menu.getByText("0 of 0 tools on").count()).toBe(0);

      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).nth(1).click();
      await expect.poll(() => menu.getAttribute("data-view")).toBe("tools:notion");
      await expect
        .poll(() =>
          menu.getByText("MCP tools will appear here after an agent run discovers them.").count(),
        )
        .toBe(0);
      await expect
        .poll(() => menu.getByText("No tools available for this connector.").isVisible())
        .toBe(true);
      await expect.poll(() => menu.getByText("0 of 0 tools on").count()).toBe(0);
    });
  });

  it("uses the generic empty state for an unscoped discovery notice", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "tools.effective"],
        methodResponses: {
          "config.get": configResponse({
            github: { url: "https://mcp.example.test", enabled: true },
          }),
          "sessions.list": sessionsList(),
          "tools.effective": undiscoveredMcpToolsResponse("github", false),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = await openMenu(page);
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).click();

      await expect.poll(() => menu.getAttribute("data-view")).toBe("tools:github");
      await expect
        .poll(() => menu.getByText("No tools available for this connector.").isVisible())
        .toBe(true);
      await expect
        .poll(() =>
          menu.getByText("MCP tools will appear here after an agent run discovers them.").count(),
        )
        .toBe(0);
      await expect.poll(() => menu.getByText("0 of 0 tools on").count()).toBe(0);
    });
  });

  it("blocks tool mutations until the session, runtime config, and catalog are ready", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        featureMethods: ["chat.metadata", "chat.startup", "sessions.patch", "tools.effective"],
        deferredMethods: ["tools.effective"],
        heldMethods: ["sessions.list"],
        methodResponses: {
          // Keep the session projection unavailable until the held list arrives.
          "chat.startup": { messages: [], sessionId: "session:agent:main:main" },
          "sessions.describe": { session: null },
          "config.get": configResponse({
            github: { url: "https://mcp.example.test", enabled: true },
          }),
          "tools.effective": effectiveToolsResponse(),
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("sessions.list");
      const composer = await openMenu(page);
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).click();
      await gateway.waitForRequest("tools.effective");
      await expect.poll(() => menu.getByText("Loading tools…").isVisible()).toBe(true);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      await gateway.resolveDeferred("tools.effective", effectiveToolsResponse());
      const listIssues = menu.locator('wa-dropdown-item[value="mcp-tool:0"]');
      await expect.poll(() => listIssues.isDisabled()).toBe(true);
      await expect.poll(() => tooltipTitleText(listIssues)).toBe("Loading…");
      await listIssues.evaluate((item) => {
        item
          .closest("wa-dropdown")
          ?.dispatchEvent(new CustomEvent("wa-select", { bubbles: true, detail: { item } }));
      });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      await gateway.resolveDeferred("sessions.list", sessionsList());
      await expect.poll(() => menu.getAttribute("data-view")).toBe("tools:github");
      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitem", { name: "Tool access" }).click();
      const readyListIssues = menu.locator('wa-dropdown-item[value="mcp-tool:0"]');
      await expect.poll(() => readyListIssues.isDisabled()).toBe(false);
      await readyListIssues.click();
      await expect
        .poll(() => latestToolOverrides(gateway))
        .toEqual({ mcpToolsDeny: { github: ["list-issues"] } });
    });
  });

  it("disables capability mutations and admin rows for a read-only operator", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        operatorScopes: ["operator.read"],
        methodResponses: {
          "config.get": configResponse({ github: { url: "https://mcp.example.test" } }),
          "sessions.list": sessionsList({ webSearch: false }),
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: [skill("Docs")],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = await openMenu(page);
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      const clear = menu.locator('wa-dropdown-item[value="clear-overrides"]');
      await expect.poll(() => clear.isDisabled()).toBe(true);
      await expect.poll(() => tooltipTitleText(clear)).toContain("operator.admin access");
      await expect.poll(() => webSearchItem(menu).isDisabled()).toBe(true);
      await menu.getByRole("menuitem", { name: /^Skills/ }).click();
      const docs = menu.getByRole("menuitem", { name: /^Docs/ });
      await expect.poll(() => docs.isDisabled()).toBe(true);
      await expect.poll(() => tooltipTitleText(docs)).toContain("operator.admin access");
      // Leave disabled-row hints before the next click's hit test. Returning to
      // the root can put Web search under the pointer that clicked Back.
      await composer.locator("textarea").hover();
      await menu.getByRole("menuitem", { name: "Back" }).click();
      await composer.locator("textarea").hover();
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expect
        .poll(() => menu.getByRole("menuitem", { name: /^github/ }).isDisabled())
        .toBe(true);
      const browse = menu.getByRole("menuitem", { name: "Browse connectors" });
      await expect.poll(() => browse.isDisabled()).toBe(true);
      await browse.hover();
      await expect.poll(() => tooltipTitleText(browse)).toContain("Admin access");
      const addServer = menu.getByRole("menuitem", { name: /Add MCP server/ });
      await expect.poll(() => addServer.isDisabled()).toBe(true);
      await expect.poll(() => tooltipTitleText(addServer)).toContain("Admin access");
    });
  });

  it("blocks capability mutations until the session row and runtime config load", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        deferredMethods: ["sessions.list", "config.get"],
        methodResponses: {
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: [skill("Docs")],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      await Promise.all([
        gateway.waitForRequest("sessions.list"),
        gateway.waitForRequest("config.get"),
      ]);
      const composer = await openMenu(page);
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      const webSearch = webSearchItem(menu);
      await expect.poll(() => webSearch.isDisabled()).toBe(true);
      await expect.poll(() => tooltipTitleText(webSearch)).toBe("Loading…");
      await webSearch.evaluate((item) => {
        item
          .closest("wa-dropdown")
          ?.dispatchEvent(new CustomEvent("wa-select", { bubbles: true, detail: { item } }));
      });
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      await gateway.resolveDeferred(
        "sessions.list",
        sessionsList({
          mcpToolsDeny: { notion: ["delete_page"] },
          webSearch: true,
        }),
      );
      await expect.poll(() => webSearchItem(menu).isDisabled()).toBe(true);
      await expect.poll(() => tooltipTitleText(webSearchItem(menu))).toBe("Loading…");
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      await gateway.resolveDeferred("config.get", configResponse({}, false));
      await expect.poll(() => webSearchItem(menu).isDisabled()).toBe(false);
      await webSearchItem(menu).click();
      await expect
        .poll(() => latestToolOverrides(gateway))
        .toEqual({
          mcpToolsDeny: { notion: ["delete_page"] },
        });
    });
  });

  it("shows empty skills and connector states", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse({}, false),
          "sessions.list": sessionsList(),
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: [],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      const composer = await openMenu(page);
      const menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await expect.poll(() => webSearchItem(menu).count()).toBe(1);
      await menu.getByRole("menuitem", { name: /^Skills/ }).click();
      await expect.poll(() => menu.getByText("No skills available.").isVisible()).toBe(true);
      await menu.getByRole("menuitem", { name: "Back" }).click();
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expect.poll(() => menu.getByText("No MCP servers configured.").isVisible()).toBe(true);
    });
  });

  it("validates and adds MCP servers for session and everywhere scopes", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "config.get": configResponse({}, false),
          "sessions.list": sessionsList({ skills: { docs: false } }),
          "skills.status": {
            workspaceDir: "/tmp/openclaw-e2e/workspace",
            managedSkillsDir: "/tmp/openclaw-e2e/skills",
            skills: [],
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}chat`);
      let composer = await openMenu(page);
      let menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await menu.getByRole("menuitem", { name: /Add MCP server/ }).click();

      const dialog = page.getByRole("dialog", { name: "Add MCP server" });
      const modal = page.locator("openclaw-modal-dialog").filter({ hasText: "Add MCP server" });
      await expect.poll(() => dialog.isVisible()).toBe(true);
      const sessionScope = modal.locator('wa-radio[value="session"]');
      await expect
        .poll(() =>
          sessionScope.evaluate((radio) => (radio as HTMLElement & { checked: boolean }).checked),
        )
        .toBe(true);
      await modal.getByLabel("Name").fill("bad name");
      await modal.getByLabel("URL or command").fill("https://mcp.example.test");
      await modal.getByRole("button", { name: "Add server" }).click();
      await expect
        .poll(() => modal.getByRole("alert").textContent())
        .toContain("Server names use letters");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await modal.getByLabel("Name").fill("session-docs");
      await modal.getByLabel("URL or command").fill("ftp://mcp.example.test");
      await modal.getByRole("button", { name: "Add server" }).click();
      await expect
        .poll(() => modal.getByRole("alert").textContent())
        .toContain("Enter a URL for HTTP transports");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await modal.getByLabel("URL or command").fill("https://session.example.test/mcp");
      await gateway.deferNext("config.patch");
      await modal.getByRole("button", { name: "Add server" }).click();
      const sessionConfigPatch = await gateway.waitForRequest("config.patch");
      expect(configPatchRaw(sessionConfigPatch)).toEqual({
        mcp: {
          servers: {
            "session-docs": {
              enabled: false,
              transport: "streamable-http",
              url: "https://session.example.test/mcp",
            },
          },
        },
      });
      await gateway.setMethodResponse(
        "config.get",
        configResponse(
          {
            "session-docs": {
              enabled: false,
              transport: "streamable-http",
              url: "https://session.example.test/mcp",
            },
          },
          false,
          "capability-menu-config-1",
        ),
      );
      await gateway.resolveDeferred("config.patch", { ok: true });
      await expect
        .poll(() => latestToolOverrides(gateway))
        .toEqual({ mcpServers: { "session-docs": true }, skills: { docs: false } });
      await expect.poll(() => modal.count()).toBe(0);

      composer = await openMenu(page);
      menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expect
        .poll(() => menu.getByRole("menuitem", { name: /session-docs.*session/ }).isVisible())
        .toBe(true);
      await menu.getByRole("menuitem", { name: /Add MCP server/ }).click();

      const everywhereDialog = page
        .locator("openclaw-modal-dialog")
        .filter({ hasText: "Add MCP server" });
      await everywhereDialog.locator('wa-radio[value="everywhere"]').click();
      await everywhereDialog.getByLabel("Name").fill("global-docs");
      await everywhereDialog.getByLabel("URL or command").fill("docs-mcp --stdio");
      await everywhereDialog.getByLabel("Transport").selectOption("stdio");
      const sessionPatchCount = (await gateway.getRequests("sessions.patch")).length;
      // Pin past the session-scoped config.patch above so a slow runner can't
      // return it stale for the everywhere-scoped save.
      const configPatchesBeforeEverywhereAdd = (await gateway.getRequests("config.patch")).length;
      await gateway.deferNext("config.patch");
      await everywhereDialog.getByRole("button", { name: "Add server" }).click();
      const everywhereConfigPatch = await gateway.waitForRequest("config.patch", {
        after: configPatchesBeforeEverywhereAdd,
      });
      expect(configPatchRaw(everywhereConfigPatch)).toEqual({
        mcp: {
          servers: {
            "global-docs": { args: ["--stdio"], command: "docs-mcp" },
          },
        },
      });
      await gateway.setMethodResponse(
        "config.get",
        configResponse(
          {
            "global-docs": { args: ["--stdio"], command: "docs-mcp" },
            "session-docs": {
              enabled: false,
              transport: "streamable-http",
              url: "https://session.example.test/mcp",
            },
          },
          false,
          "capability-menu-config-2",
        ),
      );
      await gateway.resolveDeferred("config.patch", { ok: true });
      await expect.poll(() => everywhereDialog.count()).toBe(0);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(sessionPatchCount);

      composer = await openMenu(page);
      menu = composer.locator("wa-dropdown.agent-chat__capability-menu");
      await menu.getByRole("menuitem", { name: /^Connectors/ }).click();
      await expect
        .poll(() => menu.getByRole("menuitem", { name: /^global-docs.*Enabled/ }).isVisible())
        .toBe(true);
    });
  });
});

// Control UI E2E tests cover chip-selected page scope and the all-agents escape.
import path from "node:path";
import type { Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  installMockGateway,
  waitForControlUiRoute,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI agent page scope",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let proofDir: string;
beforeEach(() => {
  if (captureUiProof) {
    proofDir = createControlUiE2eArtifactDir("agent-page-scope");
  }
});

function requestParams(request: { params?: unknown }): Record<string, unknown> {
  return request.params && typeof request.params === "object"
    ? (request.params as Record<string, unknown>)
    : {};
}

async function waitForRequest(
  gateway: MockGatewayControls,
  method: string,
  predicate: (params: Record<string, unknown>) => boolean,
) {
  await expect
    .poll(async () =>
      (await gateway.getRequests(method)).some((request) => predicate(requestParams(request))),
    )
    .toBe(true);
}

async function screenshot(page: Page, name: string) {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({
    animations: "disabled",
    fullPage: true,
    path: path.join(proofDir, name),
  });
}

const emptyUsage = {
  updatedAt: Date.now(),
  sessions: [],
  totals: null,
  aggregates: {
    messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
    tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
    byModel: [],
    byProvider: [],
    byAgent: [],
    byChannel: [],
    daily: [],
  },
};

const multiAgentRoster = [
  { id: "main", identity: { name: "Main" }, name: "Main" },
  { id: "reviewer", identity: { name: "Reviewer" }, name: "Reviewer" },
  { id: "writer", identity: { name: "Writer" }, name: "Writer" },
];

suite.define(() => {
  it("follows the visible catalog groups when selecting an agent with the keyboard", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          featureMethods: ["cron.list"],
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                multiAgentRoster[0],
                { id: "alpha", name: "Needle Alpha" },
                { id: "charlie", name: "Needle Charlie" },
              ],
            },
            "cron.list": { jobs: [{ id: "bravo", name: "Needle Bravo" }] },
            "sessions.list": { ts: 1, path: "", count: 0, defaults: {}, sessions: [] },
            "sessions.usage": emptyUsage,
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        await gateway.waitForRequest("agents.list");
        await page.keyboard.press("ControlOrMeta+k");
        const input = page.locator(".cmd-palette__input");
        await input.fill("Needle");
        await page.getByRole("option", { name: "Needle Bravo", exact: true }).waitFor();
        const options = page.locator("openclaw-command-palette").getByRole("option");
        await expect
          .poll(async () =>
            (await options.allTextContents()).map((text) => text.replace(/\s+/g, " ").trim()),
          )
          .toEqual(["Needle Alpha alpha", "Needle Charlie charlie", "Needle Bravo"]);
        await input.press("ArrowDown");
        await expect.poll(() => options.nth(1).getAttribute("aria-selected")).toBe("true");
        await screenshot(page, "09-palette-keyboard-group-order.png");
        await input.press("Enter");
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/charlie");
      },
    );
  });

  it.each(["ordinary reload", "route before hello"])(
    "opens a named agent from the palette without changing the chat agent (%s)",
    async (ordering) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            deferredMethods: ordering === "route before hello" ? ["connect"] : [],
            methodResponses: {
              "agents.list": {
                defaultId: "main",
                mainKey: "main",
                scope: "per-sender",
                agents: multiAgentRoster,
              },
              "sessions.usage": emptyUsage,
            },
          });
          await page.goto(`${suite.server.baseUrl}usage`);
          if (ordering === "route before hello") {
            await gateway.waitForRequest("connect");
            await gateway.resolveDeferred("connect");
          }
          await gateway.waitForRequest("agents.list");
          const sidebar = page.locator("openclaw-app-sidebar");
          await expect
            .poll(async () =>
              (await sidebar.locator(".sidebar-agent-card__name").textContent())?.trim(),
            )
            .toBe("Main");
          await page.keyboard.press("ControlOrMeta+k");
          await page.locator(".cmd-palette__input").fill("Reviewer");
          const result = page.getByRole("option", { name: "Reviewer reviewer", exact: true });
          await result.waitFor();
          await screenshot(page, "07-palette-reviewer-result.png");
          await result.click();
          const selectedAgent = page.locator("openclaw-agents-page openclaw-agent-select");
          await selectedAgent.waitFor();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/reviewer");
          await expect
            .poll(() =>
              selectedAgent.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
            )
            .toBe("reviewer");
          await screenshot(page, "08-palette-selected-agent.png");
          await page.reload();
          if (ordering === "route before hello") {
            await gateway.waitForRequest("connect");
            // The route can settle before hello; its explicit target must survive
            // until the canonical roster arrives from the new connection.
            await waitForControlUiRoute(page, {
              pathname: "/settings/agents/reviewer",
              routeId: "agents",
            });
            await gateway.resolveDeferred("connect");
          }
          await expect
            .poll(() =>
              selectedAgent.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
            )
            .toBe("reviewer");
          await waitForRequest(
            gateway,
            "agents.files.list",
            (params) => params.agentId === "reviewer",
          );
          await screenshot(page, "10-reloaded-reviewer.png");
          await page.goBack();
          await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
          await expect
            .poll(async () =>
              (await sidebar.locator(".sidebar-agent-card__name").textContent())?.trim(),
            )
            .toBe("Main");
        },
      );
    },
  );

  it("preserves an in-flight canonical roster refresh while chat startup is delayed", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1440 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          deferredMethods: ["chat.startup"],
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("agents.list");
        await gateway.deferNext("agents.list");
        await gateway.emitGatewayEvent("config.changed", { path: "agents.entries" });
        await gateway.waitForRequest("agents.list", { after: 1 });
        await gateway.resolveDeferred("chat.startup", {
          messages: [],
          metadata: { models: [] },
          sessionId: "session:agent:main:main",
          thinkingLevel: null,
        });
        await gateway.resolveDeferred("agents.list", {
          defaultId: "research",
          mainKey: "main",
          scope: "per-sender",
          agents: [{ id: "research", name: "Research" }],
        });

        const sidebar = page.locator("openclaw-app-sidebar");
        await expect
          .poll(async () =>
            (await sidebar.locator(".sidebar-agent-card__name").textContent())?.trim(),
          )
          .toBe("Research");
      },
    );
  });

  it("keeps a refreshed canonical roster while chat startup remains delayed", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
        ...(captureUiProof
          ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1440 } } }
          : {}),
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          defaultAgentId: "main",
          deferredMethods: ["chat.startup"],
          methodResponses: {
            "agents.list": {
              defaultId: "research",
              mainKey: "main",
              scope: "per-sender",
              agents: [
                { id: "research", name: "Research" },
                { id: "writer", name: "Writer" },
              ],
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        await gateway.waitForRequest("chat.startup");
        await gateway.waitForRequest("agents.list");
        await gateway.emitGatewayEvent("config.changed", { path: "agents.entries" });
        await gateway.waitForRequest("agents.list", { after: 1 });

        const sidebar = page.locator("openclaw-app-sidebar");
        const agentName = sidebar.locator(".sidebar-agent-card__name");
        await expect.poll(async () => (await agentName.textContent())?.trim()).toBe("Research");

        await gateway.resolveDeferred("chat.startup", {
          messages: [],
          metadata: { models: [] },
          sessionId: "session:agent:main:main",
          thinkingLevel: null,
        });

        await expect.poll(async () => (await agentName.textContent())?.trim()).toBe("Research");
        await expect
          .poll(() =>
            page.locator("openclaw-chat-pane").evaluate((pane) => {
              const state = (
                pane as HTMLElement & {
                  state?: {
                    agentsList?: { agents?: Array<{ id?: string }>; defaultId?: string };
                    agentsSelectedId?: string;
                  };
                }
              ).state;
              return {
                defaultId: state?.agentsList?.defaultId,
                ids: state?.agentsList?.agents?.map((agent) => agent.id),
                selectedId: state?.agentsSelectedId,
              };
            }),
          )
          .toEqual({
            defaultId: "research",
            ids: ["research", "writer"],
            selectedId: "research",
          });

        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        const agentMenu = sidebar.locator("wa-dropdown.sidebar-agent-menu");
        await agentMenu.getByText("Research", { exact: true }).waitFor();
        await agentMenu.getByText("Writer", { exact: true }).waitFor();
        expect(await agentMenu.getByText("Stale Main", { exact: true }).count()).toBe(0);
        await screenshot(page, "00-refreshed-roster-wins.png");
      },
    );
  });

  it("scopes pages from the chip and keeps Agents settings independent", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: multiAgentRoster,
            },
            "chat.startup": {
              agentsList: {
                defaultId: "main",
                mainKey: "main",
                scope: "per-sender",
                agents: multiAgentRoster,
              },
              messages: [],
              metadata: { models: [] },
              sessionId: "session:agent:main:main",
              thinkingLevel: null,
            },
            "sessions.list": {
              count: 0,
              defaults: { contextTokens: null, model: null, modelProvider: null },
              path: "",
              sessions: [],
              ts: Date.now(),
            },
            "sessions.usage": emptyUsage,
          },
        });

        await page.goto(`${suite.server.baseUrl}usage`);
        await gateway.waitForRequest("agents.list");
        const sidebar = page.locator("openclaw-app-sidebar");
        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        const agentMenu = sidebar.locator("wa-dropdown.sidebar-agent-menu");
        // The card sits at the top of the sidebar: the menu drops below it so the
        // agent you clicked (and its checkmark row) stays visible.
        await expect
          .poll(async () => {
            const [card, menu] = await Promise.all([
              sidebar.locator(".sidebar-agent-card__main").boundingBox(),
              agentMenu.locator('[part~="menu"], .wa-dropdown__menu').first().boundingBox(),
            ]);
            if (!card || !menu) {
              return null;
            }
            return { belowCard: menu.y >= card.y + card.height, leftAligned: menu.x <= card.x + 4 };
          })
          .toEqual({ belowCard: true, leftAligned: true });
        await agentMenu.locator('wa-dropdown-item[value="agent:writer"]').click();
        await waitForRequest(gateway, "sessions.list", (params) => params.agentId === "writer");
        await expect
          .poll(async () =>
            (await sidebar.locator(".sidebar-agent-card__name").textContent())?.trim(),
          )
          .toBe("Writer");

        await sidebar.getByRole("link", { name: "Home" }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/writer");
        await sidebar.locator(".sidebar-identity-card").click();
        await sidebar
          .locator('wa-dropdown.sidebar-identity-menu wa-dropdown-item[value="command:usage"]')
          .click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
        await waitForRequest(gateway, "sessions.usage", (params) => params.agentId === "writer");
        const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
        await expect
          .poll(() =>
            pageScope.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
          )
          .toBe("writer");
        await screenshot(page, "01-writer-usage.png");

        await sidebar.getByRole("button", { name: /Switch agent/ }).click();
        await sidebar
          .locator("wa-dropdown.sidebar-agent-menu")
          .locator('wa-dropdown-item[value="command:agent-settings"]')
          .click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents/writer");
        expect(new URL(page.url()).searchParams.get("agent")).toBeNull();
        await screenshot(page, "03-writer-settings.png");
      },
    );
  });

  it("updates the compact session scope label and exposes All agents", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": {
              defaultId: "main",
              mainKey: "main",
              scope: "per-sender",
              agents: multiAgentRoster,
            },
            "sessions.list": {
              count: 0,
              defaults: { contextTokens: null, model: null, modelProvider: null },
              path: "",
              sessions: [],
              ts: Date.now(),
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}sessions`);
        await gateway.waitForRequest("agents.list");
        const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
        await expect
          .poll(() =>
            pageScope.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
          )
          .toBe("main");

        await pageScope.locator(".agent-select__trigger").click();
        await pageScope
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "Writer" })
          .click();

        await waitForRequest(gateway, "sessions.list", (params) => params.agentId === "writer");
        await expect
          .poll(() =>
            pageScope.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
          )
          .toBe("writer");
        await expect
          .poll(async () => (await pageScope.locator(".agent-select__label").textContent())?.trim())
          .toBe("Writer");
        await screenshot(page, "05-first-session-scope-switch.png");

        const sessionRequestsBeforeAll = (await gateway.getRequests("sessions.list")).length;
        await pageScope.locator(".agent-select__trigger").click();
        await pageScope
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "All agents" })
          .evaluate((item) => (item as HTMLElement).click());
        await expect
          .poll(async () => {
            const requests = await gateway.getRequests("sessions.list");
            return requests
              .slice(sessionRequestsBeforeAll)
              .some((request) => !Object.hasOwn(requestParams(request), "agentId"));
          })
          .toBe(true);
        await expect
          .poll(() =>
            pageScope.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
          )
          .toBe("");
        await expect
          .poll(async () => (await pageScope.locator(".agent-select__label").textContent())?.trim())
          .toBe("All agents");
        await screenshot(page, "06-all-agents-session-scope.png");
      },
    );
  });
});

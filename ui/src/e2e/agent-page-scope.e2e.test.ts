// Control UI E2E tests cover chip-selected page scope and the all-agents escape.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDir = path.join(process.cwd(), ".artifacts", "control-ui-e2e", "agent-page-scope");

let browser: Browser;
let server: ControlUiE2eServer;

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
  await mkdir(proofDir, { recursive: true });
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

describeControlUiE2e("Control UI agent page scope", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is not available at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("scopes pages from the chip and keeps Agents settings independent", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
          agents: multiAgentRoster,
        },
        "chat.startup": {
          agentsList: {
            defaultId: "main",
            mainKey: "main",
            scope: "agent",
            agents: multiAgentRoster,
          },
          messages: [],
          metadata: { models: [] },
          sessionId: "control-ui-e2e-session",
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

    try {
      await page.goto(`${server.baseUrl}usage`);
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
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/agents");
      await expect.poll(() => new URL(page.url()).searchParams.get("agent")).toBe("writer");
      await screenshot(page, "03-writer-settings.png");
    } finally {
      await context.close();
    }
  });

  it("updates the compact session scope label and exposes All agents", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "agents.list": {
          defaultId: "main",
          mainKey: "main",
          scope: "agent",
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

    try {
      await page.goto(`${server.baseUrl}sessions`);
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
    } finally {
      await context.close();
    }
  });
});

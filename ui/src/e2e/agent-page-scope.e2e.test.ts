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

  it("scopes pages from the chip, exposes All agents, and keeps Agents settings independent", async () => {
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
          agents: [
            { id: "main", identity: { name: "Main" }, name: "Main" },
            { id: "writer", identity: { name: "Writer" }, name: "Writer" },
          ],
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
      await sidebar
        .locator("wa-dropdown.sidebar-agent-menu")
        .locator('wa-dropdown-item[value="agent:writer"]')
        .click();
      await waitForRequest(gateway, "sessions.list", (params) => params.agentId === "writer");
      await expect
        .poll(async () =>
          (await sidebar.locator(".sidebar-agent-card__name").textContent())?.trim(),
        )
        .toBe("Writer");

      await sidebar.getByRole("link", { name: "Usage" }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
      await waitForRequest(gateway, "sessions.usage", (params) => params.agentId === "writer");
      const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
      await expect
        .poll(() =>
          pageScope.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
        )
        .toBe("writer");
      await screenshot(page, "01-writer-usage.png");

      const scopeTrigger = pageScope.locator(".agent-select__trigger");
      const usageRequestsBeforeAll = (await gateway.getRequests("sessions.usage")).length;
      await scopeTrigger.click();
      await pageScope
        .locator("wa-dropdown-item[data-agent-option]")
        .filter({ hasText: "All agents" })
        .evaluate((item) => (item as HTMLElement).click());
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("sessions.usage");
          return requests
            .slice(usageRequestsBeforeAll)
            .some((request) => !Object.hasOwn(requestParams(request), "agentId"));
        })
        .toBe(true);
      await expect
        .poll(async () =>
          (await sidebar.locator(".sidebar-agent-card__name").textContent())?.trim(),
        )
        .toBe("Writer");
      await screenshot(page, "02-all-agents-usage.png");

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
});

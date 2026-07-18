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
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const proofDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const baselineOnly = process.env.OPENCLAW_UI_E2E_BASELINE === "1";

let browser: Browser;
let server: ControlUiE2eServer;

function workspaceDoc(
  workspaceVersion = 1,
  pending: readonly string[] = ["sales-map", "unsafe-card"],
) {
  return {
    doc: {
      schemaVersion: 1,
      workspaceVersion,
      tabs: [
        {
          slug: "operations",
          title: "Operations",
          hidden: false,
          createdBy: "agent:main",
          widgets: [
            {
              id: "agent_status",
              kind: "builtin:agent-status",
              title: "Agent status",
              grid: { x: 0, y: 0, w: 7, h: 4 },
              collapsed: false,
              createdBy: "agent:main",
              bindings: { value: { source: "rpc", method: "sessions.list" } },
            },
            {
              id: "custom_widget_approvals",
              kind: "builtin:custom-widget-approvals",
              title: "Pending custom widgets",
              grid: { x: 7, y: 0, w: 5, h: 4 },
              collapsed: false,
              createdBy: "agent:main",
            },
          ],
        },
      ],
      widgetsRegistry: Object.fromEntries(
        pending.map((name) => [
          name,
          {
            status: "pending",
            createdBy: name === "sales-map" ? "agent:sales" : "agent:security",
          },
        ]),
      ),
      prefs: { tabOrder: ["operations"] },
    },
    workspaceVersion,
  };
}

function sessions(active: boolean) {
  return {
    count: 2,
    sessions: [
      {
        key: "agent:main:main",
        displayName: "Release coordinator",
        hasActiveRun: active,
        goal: active
          ? { objective: "Validate workspace operations", tokensUsed: 72, tokenBudget: 100 }
          : undefined,
      },
      { key: "agent:reviewer:main", displayName: "Review agent", hasActiveRun: false },
    ],
  };
}

async function capture(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.screenshot({ fullPage: true, path: path.join(proofDir, name) });
}

describeControlUiE2e("Control UI workspace operations widgets", () => {
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

  it("refreshes live status and completes the bounded custom-widget approval flow", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      controlUiTabs: [
        { pluginId: "workspaces", id: "workspaces", label: "Workspaces", group: "control" },
      ],
      featureMethods: [
        "sessions.list",
        "sessions.subscribe",
        "workspaces.get",
        "workspaces.widget.approve",
      ],
      methodResponses: {
        "sessions.list": sessions(false),
        "sessions.subscribe": { ok: true },
        "workspaces.get": workspaceDoc(),
        "workspaces.widget.approve": { ok: true },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}plugin?plugin=workspaces&id=workspaces`);
      expect(response?.status()).toBe(200);
      await page.locator('[data-test-id="workspace-onboarding-dismiss"]').click();
      await page.locator('[data-test-id="workspace-grid"]').waitFor({ timeout: 10_000 });
      if (baselineOnly) {
        await capture(page, "workspace-operations-before.png");
        return;
      }

      const status = page.locator('[data-test-id="workspace-agent-status"]');
      const decisions = page.locator('[data-test-id="workspace-custom-widget-approvals"]');
      await status.waitFor({ timeout: 10_000 });
      await decisions.waitFor({ timeout: 10_000 });

      expect(await status.textContent()).toContain("Idle");
      expect(await decisions.locator("li").count()).toBe(2);

      await gateway.setMethodResponse("sessions.list", sessions(true));
      const statusRequests = (await gateway.getRequests("sessions.list")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        key: "agent:main:main",
        hasActiveRun: true,
        status: "running",
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(statusRequests);
      await expect.poll(() => status.textContent()).toContain("Busy");
      await capture(page, "workspace-operations-live-and-pending.png");

      const salesRow = decisions.locator("li", { hasText: "sales-map" });
      await salesRow.locator('[data-test-id="workspace-custom-widget-approve"]').click();
      await expect
        .poll(async () => (await gateway.getRequests("workspaces.widget.approve")).at(-1)?.params)
        .toEqual({ name: "sales-map", decision: "approved" });
      await gateway.setMethodResponse("workspaces.get", workspaceDoc(2, ["unsafe-card"]));
      await gateway.emitGatewayEvent("plugin.workspaces.changed", { workspaceVersion: 2 });
      await expect.poll(() => decisions.locator("li").count()).toBe(1);

      const unsafeRow = decisions.locator("li", { hasText: "unsafe-card" });
      await unsafeRow.locator('[data-test-id="workspace-custom-widget-reject"]').click();
      await expect
        .poll(async () => (await gateway.getRequests("workspaces.widget.approve")).at(-1)?.params)
        .toEqual({ name: "unsafe-card", decision: "rejected" });
      await gateway.setMethodResponse("workspaces.get", workspaceDoc(3, []));
      await gateway.emitGatewayEvent("plugin.workspaces.changed", { workspaceVersion: 3 });
      await expect.poll(() => decisions.count()).toBe(0);
      await expect
        .poll(() => page.locator('[data-widget-id="custom_widget_approvals"]').textContent())
        .toContain("No custom widgets are awaiting approval");
      await capture(page, "workspace-operations-decisions-complete.png");
    } finally {
      await context.close();
    }
  });
});

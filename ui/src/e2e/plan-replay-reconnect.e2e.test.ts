// Control UI tests cover plan-snapshot replay on connect/reconnect.
import { chromium, expect, type Browser, type BrowserContext, type Page } from "playwright/test";
import { afterAll, afterEach, beforeAll, describe, it } from "vitest";
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

let server: ControlUiE2eServer;
let browser: Browser;
const openBrowserContexts = new Set<BrowserContext>();

const REPLAY_RUN_ID = "run-plan-replay";
// Mirrors the gateway's chat.history/chat.startup inFlightRun recovery payload.
const replayScenario = {
  inFlightRun: {
    runId: REPLAY_RUN_ID,
    text: "",
    plan: {
      explanation: "Restore the checklist after reconnect",
      steps: [
        { step: "Inspect the primes script", status: "completed" },
        { step: "Add a docstring", status: "in_progress" },
        { step: "Verify the output", status: "pending" },
      ],
    },
  },
  sessionInfo: { activeRunIds: [REPLAY_RUN_ID], hasActiveRun: true, key: "main" },
};

async function newPage(): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1280 },
  });
  openBrowserContexts.add(context);
  return { context, page: await context.newPage() };
}

async function closeBrowserContext(context: BrowserContext): Promise<void> {
  openBrowserContexts.delete(context);
  await context.close();
}

describeControlUiE2e("Control UI plan snapshot replay", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterEach(async () => {
    for (const context of openBrowserContexts) {
      await closeBrowserContext(context);
    }
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("seeds the plan checklist from a replayed in-flight snapshot on load", async () => {
    const { context, page } = await newPage();
    await installMockGateway(page, replayScenario);
    try {
      await page.goto(`${server.baseUrl}chat`);

      // The checklist must render from the replayed snapshot alone, before any
      // live plan event arrives — this is the reconnect gap the replay closes.
      const checklist = page.locator(".plan-checklist").first();
      await checklist.waitFor({ state: "visible", timeout: 10_000 });
      await checklist.getByText("Add a docstring").first().waitFor({ timeout: 10_000 });
      await page.getByText("1/3").first().waitFor({ timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("replaces the seeded snapshot with a newer live plan event and clears with the run", async () => {
    const { context, page } = await newPage();
    const gateway = await installMockGateway(page, replayScenario);
    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.locator(".plan-checklist").first().waitFor({ state: "visible", timeout: 10_000 });
      // Bar + in-thread card render for an active run; the live event must
      // replace both in place, not mount additional checklists.
      const seededChecklistCount = await page.locator(".plan-checklist").count();

      await gateway.emitGatewayEvent("agent", {
        data: {
          phase: "update",
          steps: [
            { step: "Inspect the primes script", status: "completed" },
            { step: "Add a docstring", status: "completed" },
            { step: "Verify the output", status: "in_progress" },
          ],
        },
        runId: REPLAY_RUN_ID,
        seq: 1,
        sessionKey: "main",
        stream: "plan",
        ts: Date.now(),
      });
      await page.getByText("2/3").first().waitFor({ timeout: 10_000 });
      await expect(page.getByText("1/3")).toHaveCount(0);
      await expect(page.locator(".plan-checklist")).toHaveCount(seededChecklistCount);

      // Terminal run outcome clears the checklist through the existing lifecycle.
      await gateway.emitChatFinal({ runId: REPLAY_RUN_ID, text: "All steps complete." });
      await page.locator(".plan-checklist").first().waitFor({ state: "detached", timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });

  it("restores the checklist from the snapshot after a mid-run page reload", async () => {
    const { context, page } = await newPage();
    await installMockGateway(page, replayScenario);
    try {
      await page.goto(`${server.baseUrl}chat`);
      await page.locator(".plan-checklist").first().waitFor({ state: "visible", timeout: 10_000 });

      // Mock routes are page-scoped, so reinstall before reload to keep serving
      // the same snapshot — the refresh-mid-run case from the live QA repro.
      await installMockGateway(page, replayScenario);
      await page.reload();
      const checklist = page.locator(".plan-checklist").first();
      await checklist.waitFor({ state: "visible", timeout: 10_000 });
      await checklist.getByText("Add a docstring").first().waitFor({ timeout: 10_000 });
    } finally {
      await closeBrowserContext(context);
    }
  });
});

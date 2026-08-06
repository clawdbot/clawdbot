// Real-browser proof + regression for #93041: provider usage from models.authStatus remains
// available in the desktop composer's context popover. Screenshots go to the ignored artifacts tree.
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
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
const describeE2e = chromiumAvailable ? describe : describe.skip;

const baseTime = 1_700_000_000_000;
const artifactDir = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/chat-quota-pill-93041");

const authStatusWithUsage = {
  ts: baseTime,
  providers: [
    {
      provider: "openai",
      displayName: "Codex",
      status: "ok",
      profiles: [{ profileId: "codex", type: "oauth", status: "ok" }],
      usage: {
        providerId: "openai",
        windows: [
          { label: "5h", usedPercent: 42, resetAt: Date.now() + 3 * 3_600_000 },
          { label: "Week", usedPercent: 71, resetAt: Date.now() + 4 * 86_400_000 },
        ],
      },
    },
  ],
};

const claudeSubscriptionAuthStatus = {
  ts: baseTime,
  providers: [
    {
      provider: "claude-cli",
      displayName: "Claude",
      status: "ok",
      profiles: [{ profileId: "claude-cli", type: "oauth", status: "ok" }],
      usage: {
        providerId: "anthropic",
        plan: "Max (20x)",
        windows: [
          { label: "5h", usedPercent: 22, resetAt: Date.now() + 4 * 3_600_000 + 48 * 60_000 },
          { label: "Week", usedPercent: 25, resetAt: Date.now() + 2 * 86_400_000 },
          { label: "Fable", usedPercent: 45 },
        ],
        billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
      },
    },
  ],
};

const claudeSubscriptionSessions = {
  count: 1,
  defaults: {
    contextTokens: 1_000_000,
    model: "claude-fable-5",
    modelProvider: "anthropic",
  },
  path: "",
  sessions: [
    {
      contextTokens: 1_000_000,
      displayName: "Main",
      estimatedCostUsd: 0.02,
      hasActiveRun: false,
      inputTokens: 2_400,
      key: "main",
      kind: "direct",
      label: "Main",
      model: "claude-fable-5",
      // sessions.list canonicalizes CLI aliases; plan matching goes through
      // the auth row's usage.providerId.
      modelProvider: "anthropic",
      outputTokens: 830,
      status: "done",
      totalTokens: 78_700,
      totalTokensFresh: true,
      updatedAt: Date.now(),
    },
  ],
  ts: Date.now(),
};

let server: ControlUiE2eServer;
let browser: Browser;

async function openChat(
  authStatus: unknown,
  extraMethodResponses: Record<string, unknown> = {},
): Promise<{
  context: BrowserContext;
  page: Page;
}> {
  let context: BrowserContext | undefined;
  let page: Page | undefined;
  try {
    context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    page = await context.newPage();
    page.setDefaultTimeout(15_000);
    const gateway = await installMockGateway(page, {
      methodResponses: { "models.authStatus": authStatus, ...extraMethodResponses },
    });
    await page.goto(`${server.baseUrl}chat`);
    await gateway.waitForRequest("models.authStatus");
    return { context, page };
  } catch (error) {
    await page?.close().catch(() => {});
    await context?.close().catch(() => {});
    throw error;
  }
}

async function closeChat(fixture: { context: BrowserContext; page: Page }): Promise<void> {
  await fixture.page.close().catch(() => {});
  await fixture.context.close().catch(() => {});
}

describeE2e("Control UI #93041 desktop chat quota popover (mocked Gateway E2E)", () => {
  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    try {
      server = await startControlUiE2eServer();
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  });

  afterAll(async () => {
    await browser?.close().catch(() => {});
    await server?.close();
  });

  it("renders provider usage inside the desktop context popover", async () => {
    const fixture = await openChat(authStatusWithUsage);
    const { page } = fixture;
    try {
      const contextRing = page.locator(".context-ring");
      const usageLink = page.locator('[data-chat-provider-usage="true"]');
      await contextRing.waitFor({ state: "visible" });
      expect(await usageLink.isVisible()).toBe(false);
      await contextRing.click();
      await usageLink.waitFor({ state: "visible" });
      await page.screenshot({ path: path.join(artifactDir, "01-chat-with-context-usage.png") });
      await page.locator(".context-usage__popover").screenshot({
        path: path.join(artifactDir, "02-context-usage-popover.png"),
      });

      expect(await usageLink.getAttribute("href")).toBe("/usage");
      const rows = await page.locator(".context-usage__limit").allTextContents();
      const normalized = rows.map((row) => row.replace(/\s+/g, " ").trim());
      expect(normalized[0]).toMatch(/^5-hour limit Resets .+ 42%$/);
      expect(normalized[1]).toMatch(/^Weekly · all models Resets .+ 71%$/);
    } finally {
      await closeChat(fixture);
    }
  });

  it("shows plan bars, credits, and no dollar estimates for subscription sessions", async () => {
    const fixture = await openChat(claudeSubscriptionAuthStatus, {
      "sessions.list": claudeSubscriptionSessions,
    });
    const { page } = fixture;
    try {
      const contextRing = page.locator(".context-ring");
      await contextRing.waitFor({ state: "visible" });
      await contextRing.click();
      await page.locator(".context-usage__popover").waitFor({ state: "visible" });
      await page.locator(".context-usage__popover").screenshot({
        path: path.join(artifactDir, "03-claude-subscription-popover.png"),
      });

      expect(await page.locator(".context-usage__plan-badge").textContent()).toBe("Max (20x)");
      const rows = await page.locator(".context-usage__limit").allTextContents();
      const normalized = rows.map((row) => row.replace(/\s+/g, " ").trim());
      expect(normalized[0]).toMatch(/^5-hour limit Resets .+ 22%$/);
      expect(normalized[1]).toMatch(/^Weekly · all models Resets .+ 25%$/);
      expect(normalized[2]).toBe("Fable 45%");
      expect(normalized[3]).toBe("Usage credits $157.85 of $400.00");

      const popoverText = (await page.locator(".context-usage__popover").textContent()) ?? "";
      expect(popoverText).not.toContain("Est. cost");
      expect(popoverText).not.toContain("Cost by Type");
      expect(popoverText).toContain("Latest run tokens");
    } finally {
      await closeChat(fixture);
    }
  });

  it("shows no plan usage when no provider usage windows are present", async () => {
    const fixture = await openChat({ ts: baseTime, providers: [] });
    const { page } = fixture;
    try {
      await page.locator(".agent-chat__composer-controls").first().waitFor({ state: "visible" });
      await page.waitForFunction(() => {
        const pane = document.querySelector("openclaw-chat-pane") as
          | (HTMLElement & {
              state?: { modelAuthStatusResult?: { providers?: unknown[] } | null };
            })
          | null;
        return Array.isArray(pane?.state?.modelAuthStatusResult?.providers);
      });
      expect(await page.locator('[data-chat-provider-usage="true"]').count()).toBe(0);
    } finally {
      await closeChat(fixture);
    }
  });
});

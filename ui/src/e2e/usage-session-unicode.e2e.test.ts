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

let browser: Browser;
let server: ControlUiE2eServer;

const usageTotals = {
  input: 100,
  output: 20,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 120,
  totalCost: 0.01,
  inputCost: 0.008,
  outputCost: 0.002,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};

function currentDay(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function usageResponse(sessionKey?: string) {
  const day = currentDay();
  return {
    updatedAt: Date.now(),
    startDate: day,
    endDate: day,
    sessions: sessionKey
      ? [
          {
            key: sessionKey,
            agentId: "main",
            modelProvider: "openai",
            model: "gpt-5.5",
            updatedAt: Date.now(),
            usage: {
              ...usageTotals,
              activityDates: [day],
              dailyBreakdown: [
                { date: day, tokens: usageTotals.totalTokens, cost: usageTotals.totalCost },
              ],
              messageCounts: {
                total: 2,
                user: 1,
                assistant: 1,
                toolCalls: 0,
                toolResults: 0,
                errors: 0,
              },
            },
          },
        ]
      : [],
    totals: usageTotals,
    aggregates: {
      messages: { total: 2, user: 1, assistant: 1, toolCalls: 0, toolResults: 0, errors: 0 },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [{ agentId: "main", totals: usageTotals }],
      byChannel: [],
      daily: [
        {
          date: day,
          tokens: usageTotals.totalTokens,
          cost: usageTotals.totalCost,
          messages: 2,
          toolCalls: 0,
          errors: 0,
        },
      ],
    },
  };
}

function costResponse() {
  return {
    updatedAt: Date.now(),
    days: 1,
    daily: [{ date: currentDay(), ...usageTotals }],
    totals: usageTotals,
  };
}

async function captureProof(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await mkdir(proofDir, { recursive: true });
  await page.locator(".usage-page").screenshot({ path: path.join(proofDir, name) });
}

describeControlUiE2e("Control UI usage session filter Unicode", () => {
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

  it.each([
    {
      name: "surrogate pair at the truncation boundary",
      key: "1234567🦞suffix",
      truncated: "1234567…",
      screenshot: "usage-session-boundary-emoji.png",
    },
    {
      name: "surrogate pair within the truncation boundary",
      key: "123456🦞suffix",
      truncated: "123456🦞…",
      screenshot: "usage-session-contained-emoji.png",
    },
    {
      name: "ordinary ASCII session key",
      key: "123456789suffix",
      truncated: "12345678…",
      screenshot: "usage-session-ascii.png",
    },
  ])("preserves $name after a selected Gateway session disappears", async (scenario) => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.usage": usageResponse(scenario.key),
        "usage.cost": costResponse(),
        "usage.status": { updatedAt: Date.now(), providers: [] },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}usage`);
      expect(response?.status()).toBe(200);
      await expect
        .poll(() => gateway.getRequests("sessions.usage"), { timeout: 10_000 })
        .not.toHaveLength(0);

      const row = page.locator(".session-bar-row").filter({ hasText: scenario.key });
      await expect.poll(() => row.count(), { timeout: 10_000 }).toBe(1);
      await row.click();

      const chip = page.locator(".filter-chip").filter({ has: page.locator(".filter-chip-label") });
      const label = chip.locator(".filter-chip-label");
      await expect.poll(() => label.textContent(), { timeout: 10_000 }).toContain(scenario.key);
      await expect.poll(() => chip.getAttribute("title")).toBe(scenario.key);

      const previousRequests = (await gateway.getRequests("sessions.usage")).length;
      await gateway.setMethodResponse("sessions.usage", usageResponse());
      await page
        .locator("openclaw-usage-page")
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      await expect
        .poll(() => gateway.getRequests("sessions.usage"), { timeout: 10_000 })
        .toHaveLength(previousRequests + 1);

      await captureProof(page, scenario.screenshot);
      await expect.poll(() => chip.getAttribute("title")).toBe(scenario.key);
      await expect.poll(() => label.textContent()).toBe(`Session: ${scenario.truncated}`);
      const renderedLabel = (await label.textContent()) ?? "";
      expect((renderedLabel as string & { isWellFormed(): boolean }).isWellFormed()).toBe(true);
      expect(renderedLabel).not.toContain("�");
    } finally {
      await context.close();
    }
  });
});

// Control UI tests cover proxy-style same-client reconnects through the real browser lifecycle.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { USAGE_PAYLOAD_TTL_MS } from "../pages/usage/refresh-policy.ts";
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
const proofDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();

let browser: Browser;
let server: ControlUiE2eServer;

const totals = {
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

function today(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function costSummary(cacheStatus?: {
  status: "refreshing" | "partial" | "ready";
  cachedFiles: number;
  pendingFiles: number;
  staleFiles: number;
}) {
  return {
    updatedAt: Date.now(),
    days: 1,
    daily: [{ date: today(), ...totals }],
    totals,
    ...(cacheStatus ? { cacheStatus } : {}),
  };
}

function sessionsUsage(cacheStatus?: ReturnType<typeof costSummary>["cacheStatus"]) {
  return {
    updatedAt: Date.now(),
    startDate: today(),
    endDate: today(),
    sessions: [
      {
        key: "agent:main:proxy-proof",
        label: "Proxy proof",
        agentId: "main",
        modelProvider: "openai",
        model: "gpt-5.5",
        updatedAt: Date.now(),
        usage: {
          ...totals,
          activityDates: [today()],
          dailyBreakdown: [{ date: today(), tokens: totals.totalTokens, cost: totals.totalCost }],
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
    ],
    totals,
    aggregates: {
      messages: { total: 2, user: 1, assistant: 1, toolCalls: 0, toolResults: 0, errors: 0 },
      tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
      byModel: [],
      byProvider: [],
      byAgent: [{ agentId: "main", totals }],
      byChannel: [],
      daily: [
        {
          date: today(),
          tokens: totals.totalTokens,
          cost: totals.totalCost,
          messages: 2,
          toolCalls: 0,
          errors: 0,
        },
      ],
    },
    ...(cacheStatus ? { cacheStatus } : {}),
  };
}

async function createContext(): Promise<BrowserContext> {
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  return browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
}

async function requestCount(gateway: MockGatewayControls, method: string): Promise<number> {
  return (await gateway.getRequests(method)).length;
}

async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<void> {
  await expect.poll(() => requestCount(gateway, method), { timeout: 10_000 }).toBe(count);
}

async function proxyReconnect(
  page: Page,
  gateway: MockGatewayControls,
  expectedSocketCount: number,
): Promise<void> {
  await gateway.closeLatest(1001, "proxy idle timeout");
  await expect.poll(() => gateway.getSocketCount(), { timeout: 10_000 }).toBe(expectedSocketCount);
  expect(await page.locator(".sidebar-footer-bar__status").count()).toBe(0);
}

async function captureProof(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await page.screenshot({ fullPage: true, path: path.join(proofDir, name) });
}

async function usageBadges(page: Page): Promise<string[]> {
  return (await page.locator(".usage-metric-badge").allTextContents()).map((value) =>
    value.replace(/\s+/gu, " ").trim(),
  );
}

describeControlUiE2e("Control UI usage proxy reconnect lifecycle", () => {
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

  it("avoids a reload storm but retries Usage work interrupted by a proxy drop", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.usage": sessionsUsage(),
        "usage.cost": costSummary(),
        "usage.status": { updatedAt: Date.now(), providers: [] },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}usage`);
      expect(response?.status()).toBe(200);
      await waitForRequestCount(gateway, "sessions.usage", 1);
      await waitForRequestCount(gateway, "usage.cost", 1);
      await page.locator(".daily-chart-compact").waitFor({ timeout: 10_000 });
      await expect.poll(() => usageBadges(page)).toEqual(["120 Tokens", "$0.01 Cost", "1 session"]);

      for (const socketCount of [2, 3, 4]) {
        await proxyReconnect(page, gateway, socketCount);
        expect(await requestCount(gateway, "sessions.usage")).toBe(1);
        expect(await requestCount(gateway, "usage.cost")).toBe(1);
      }

      await page.evaluate((ttlMs) => {
        const staleNow = Date.now() + ttlMs;
        Date.now = () => staleNow;
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "hidden",
        });
        Object.defineProperty(document, "hasFocus", {
          configurable: true,
          value: () => false,
        });
        document.dispatchEvent(new Event("visibilitychange"));
      }, USAGE_PAYLOAD_TTL_MS);
      await proxyReconnect(page, gateway, 5);
      expect(await requestCount(gateway, "sessions.usage")).toBe(1);
      expect(await requestCount(gateway, "usage.cost")).toBe(1);

      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => "visible",
        });
        Object.defineProperty(document, "hasFocus", {
          configurable: true,
          value: () => true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });
      await waitForRequestCount(gateway, "sessions.usage", 2);
      await waitForRequestCount(gateway, "usage.cost", 2);

      await gateway.deferNext("sessions.usage");
      await gateway.deferNext("usage.cost");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await waitForRequestCount(gateway, "sessions.usage", 3);
      await waitForRequestCount(gateway, "usage.cost", 3);

      await proxyReconnect(page, gateway, 6);
      await waitForRequestCount(gateway, "sessions.usage", 4);
      await waitForRequestCount(gateway, "usage.cost", 4);
      await page.locator(".daily-chart-compact").waitFor({ timeout: 10_000 });
      await expect.poll(() => usageBadges(page)).toEqual(["120 Tokens", "$0.01 Cost", "1 session"]);
      await captureProof(page, "usage-after-interrupted-retry.png");
    } finally {
      await context.close();
    }
  });

  it("keeps fresh Profile settlement quiet and preserves a manual refresh", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const refreshing = {
      status: "refreshing" as const,
      cachedFiles: 1,
      pendingFiles: 1,
      staleFiles: 0,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.usage": sessionsUsage(refreshing),
        "usage.cost": costSummary(refreshing),
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/profile`);
      expect(response?.status()).toBe(200);
      await waitForRequestCount(gateway, "sessions.usage", 1);
      await waitForRequestCount(gateway, "usage.cost", 1);
      await page.locator(".profile-stats").waitFor({ timeout: 10_000 });

      await gateway.setMethodResponse("sessions.usage", sessionsUsage());
      await gateway.setMethodResponse("usage.cost", costSummary());
      await proxyReconnect(page, gateway, 2);
      expect(await requestCount(gateway, "sessions.usage")).toBe(1);
      expect(await requestCount(gateway, "usage.cost")).toBe(1);

      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await waitForRequestCount(gateway, "sessions.usage", 2);
      await waitForRequestCount(gateway, "usage.cost", 2);
      await page.locator(".profile-stats").waitFor();
      await expect
        .poll(() => page.locator(".profile-stats__value").first().textContent())
        .toBe("120");

      await proxyReconnect(page, gateway, 3);
      expect(await requestCount(gateway, "sessions.usage")).toBe(2);
      expect(await requestCount(gateway, "usage.cost")).toBe(2);
      await expect
        .poll(() => page.locator(".profile-stats__value").first().textContent())
        .toBe("120");
      await captureProof(page, "profile-after-cache-settlement.png");
    } finally {
      await context.close();
    }
  });
});

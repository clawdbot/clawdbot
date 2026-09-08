// Control UI tests cover proxy-style same-client reconnects through the real browser lifecycle.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { BrowserContext, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import type { CostUsageSummary } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway, type MockGatewayControls } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI usage proxy reconnect lifecycle",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

// Mirrors the module-private default usage TTL asserted by this flow.
const USAGE_PAYLOAD_TTL_MS = 5 * 60_000;

const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let proofDir: string | undefined;
beforeEach(() => {
  proofDir = artifactRoot
    ? createControlUiE2eArtifactDir("usage-reconnect", artifactRoot)
    : undefined;
});

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

function costSummary(cacheStatus?: CostUsageSummary["cacheStatus"], usageTotals = totals) {
  return {
    updatedAt: Date.now(),
    days: 1,
    daily: [{ date: today(), ...usageTotals }],
    totals: usageTotals,
    ...(cacheStatus ? { cacheStatus } : {}),
  };
}

function sessionsUsage(
  cacheStatus?: ReturnType<typeof costSummary>["cacheStatus"],
  label = "Proxy proof",
  usageTotals = totals,
) {
  return {
    updatedAt: Date.now(),
    startDate: today(),
    endDate: today(),
    sessions: [
      {
        key: "agent:main:proxy-proof",
        label,
        agentId: "main",
        modelProvider: "openai",
        model: "gpt-5.5",
        updatedAt: Date.now(),
        usage: {
          ...usageTotals,
          activityDates: [today()],
          dailyBreakdown: [
            {
              ...usageTotals,
              date: today(),
              tokens: usageTotals.totalTokens,
              cost: usageTotals.totalCost,
            },
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
    ],
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
          date: today(),
          tokens: usageTotals.totalTokens,
          cost: usageTotals.totalCost,
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
  return suite.browser.newContext({
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
    ...(proofDir ? { recordVideo: { dir: proofDir, size: { height: 900, width: 1440 } } } : {}),
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
  await waitForControlUiGatewayReady(page);
  expect(await page.locator(".sidebar-footer-bar__status").count()).toBe(0);
}

async function captureProof(page: Page, name: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await writeFile(
    path.join(proofDir, name),
    await takeControlUiViewportScreenshot(page, page.locator(".usage-page"), [
      page.locator(".usage-controls"),
    ]),
  );
}

async function captureResultProof(page: Page, name: string, resultLabel: string): Promise<void> {
  if (!proofDir) {
    return;
  }
  await page.getByText(resultLabel, { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(proofDir, name) });
}

async function usageBadges(page: Page): Promise<string[]> {
  return (await page.locator(".usage-metric-badge").allTextContents()).map((value) =>
    value.replace(/\s+/gu, " ").trim(),
  );
}

suite.define(() => {
  it.each(["sessions", "cost"] as const)(
    "automatically replaces incomplete %s cache snapshots after a rebuild",
    async (incompleteSource) => {
      const context = await createContext();
      const page = await context.newPage();
      const partialTotals = { ...totals, input: 80, totalTokens: 100 };
      const freshTotals = { ...totals, input: 300, totalTokens: 320 };
      const refreshing = {
        status: "refreshing" as const,
        cachedFiles: 1,
        pendingFiles: 1,
        staleFiles: 1,
      };
      const fresh = { status: "fresh" as const, cachedFiles: 2, pendingFiles: 0, staleFiles: 0 };
      const partialSessions = sessionsUsage(
        incompleteSource === "sessions" ? refreshing : fresh,
        "Historical lineage",
        partialTotals,
      );
      const partialCost = costSummary(
        incompleteSource === "cost" ? refreshing : fresh,
        partialTotals,
      );
      const freshSessions = sessionsUsage(fresh, "Historical lineage", freshTotals);
      const freshCost = costSummary(fresh, freshTotals);
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.usage": partialSessions,
          "usage.cost": partialCost,
          "usage.status": { updatedAt: Date.now(), providers: [] },
        },
      });

      try {
        const response = await page.goto(`${suite.server.baseUrl}usage`);
        expect(response?.status()).toBe(200);
        await expect
          .poll(() =>
            page.evaluate(() => ({
              visibility: document.visibilityState,
              focused: document.hasFocus(),
            })),
          )
          .toEqual({ visibility: "visible", focused: true });
        const refresh = page
          .locator("openclaw-usage-page")
          .getByRole("button", { name: "Refresh", exact: true });
        for (const entry of ["route", "manual"] as const) {
          if (entry === "manual") {
            await gateway.setMethodResponse("sessions.usage", partialSessions);
            await gateway.setMethodResponse("usage.cost", partialCost);
            await refresh.click();
          }
          await expect
            .poll(() => usageBadges(page))
            .toEqual(["100 Tokens", "$0.01 Cost", "1 session"]);
          await expect.poll(() => refresh.isEnabled()).toBe(true);
          expect(await page.locator(".usage-callout.danger").count()).toBe(0);

          const sessionsBefore = await requestCount(gateway, "sessions.usage");
          const costBefore = await requestCount(gateway, "usage.cost");
          // Only server data changes. Publish it before optional slow media capture so
          // recording cannot spend the production retry budget on old fixture data.
          await gateway.setMethodResponse("sessions.usage", freshSessions);
          await gateway.setMethodResponse("usage.cost", freshCost);
          await expect
            .poll(() => requestCount(gateway, "sessions.usage"), { timeout: 10_000 })
            .toBeGreaterThan(sessionsBefore);
          await expect
            .poll(() => requestCount(gateway, "usage.cost"), { timeout: 10_000 })
            .toBeGreaterThan(costBefore);
          await expect
            .poll(() => usageBadges(page))
            .toEqual(["320 Tokens", "$0.01 Cost", "1 session"]);
          await expect.poll(() => refresh.isEnabled()).toBe(true);
          expect(await page.locator(".usage-callout.danger").count()).toBe(0);
          await captureProof(page, `usage-${incompleteSource}-cache-${entry}-fresh.png`);
        }
      } catch (error) {
        await captureProof(page, `usage-${incompleteSource}-cache-failed.png`);
        throw error;
      } finally {
        await context.close();
      }
    },
  );

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
      const response = await page.goto(`${suite.server.baseUrl}chat`);
      expect(response?.status()).toBe(200);
      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-identity-card").click();
      await sidebar
        .locator('wa-dropdown.sidebar-identity-menu wa-dropdown-item[value="command:usage"]')
        .click();
      await expect.poll(() => new URL(page.url()).pathname).toBe("/usage");
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
      await page
        .locator("openclaw-usage-page")
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
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

  it("keeps results aligned when scope changes during a refresh", async () => {
    const context = await createContext();
    const page = await context.newPage();
    const staleFamilyResult = sessionsUsage(undefined, "Family stale result");
    const currentInstanceResult = sessionsUsage(undefined, "Current instance result");
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.usage": staleFamilyResult,
        "usage.cost": costSummary(),
        "usage.status": { updatedAt: Date.now(), providers: [] },
      },
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}usage`);
      expect(response?.status()).toBe(200);
      await waitForRequestCount(gateway, "sessions.usage", 1);
      await page.getByText("Family stale result", { exact: true }).waitFor();

      await gateway.deferNext("sessions.usage");
      await gateway.deferNext("usage.cost");
      await page
        .locator("openclaw-usage-page")
        .getByRole("button", { name: "Refresh", exact: true })
        .click();
      await waitForRequestCount(gateway, "sessions.usage", 2);
      await waitForRequestCount(gateway, "usage.cost", 2);

      await gateway.setMethodResponse("sessions.usage", currentInstanceResult);
      await page.getByRole("button", { name: "Current instance", exact: true }).click();
      await gateway.resolveDeferred("sessions.usage", staleFamilyResult);
      await gateway.resolveDeferred("usage.cost", costSummary());
      await expect
        .poll(() =>
          page
            .locator("openclaw-usage-page")
            .getByRole("button", { name: "Refresh", exact: true })
            .isEnabled(),
        )
        .toBe(true);
      await captureProof(page, "usage-filter-during-refresh.png");

      const requests = await gateway.getRequests("sessions.usage");
      const currentResult = page.getByText("Current instance result", { exact: true });
      const staleResult = page.getByText("Family stale result", { exact: true });
      await expect
        .poll(async () => (await currentResult.count()) + (await staleResult.count()))
        .toBe(1);
      const visibleResultLabel =
        (await currentResult.count()) === 1 ? "Current instance result" : "Family stale result";
      await captureResultProof(page, "usage-filter-during-refresh-result.png", visibleResultLabel);
      expect(requests).toHaveLength(3);
      expect(requests[2]?.params).toMatchObject({ groupBy: "instance" });
      expect(await currentResult.count()).toBe(1);
      expect(await staleResult.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

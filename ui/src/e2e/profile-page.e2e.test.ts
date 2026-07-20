// Control UI tests cover the settings profile page against a mocked Gateway.
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

let browser: Browser;
let server: ControlUiE2eServer;

function costTotals(totalTokens: number) {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost: 0,
    inputCost: 0,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
    missingCostEntries: 0,
  };
}

function localDate(daysAgo: number): string {
  const date = new Date();
  date.setDate(date.getDate() - daysAgo);
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

const costDay = (daysAgo: number, tokens: number) => ({
  date: localDate(daysAgo),
  ...costTotals(tokens),
});

// Peak sits safely inside the 52-week heatmap window; the trailing three days
// give a deterministic 3-day current streak regardless of run date.
const usageCostResponse = {
  updatedAt: Date.now(),
  days: 4,
  daily: [
    costDay(10, 82_100_000_000),
    costDay(2, 900_000_000),
    costDay(1, 1_200_000_000),
    costDay(0, 400_000_000),
  ],
  totals: { ...costTotals(2_800_000_000_000), totalCost: 1234.56 },
};

const sessionsUsageResponse = {
  updatedAt: Date.now(),
  startDate: localDate(365),
  endDate: localDate(0),
  sessions: [
    {
      key: "agent:main:marathon",
      label: "marathon",
      usage: { ...costTotals(1_000), durationMs: (59 * 60 + 4) * 60 * 1000 },
    },
    {
      key: "agent:main:quickie",
      label: "quickie",
      usage: { ...costTotals(500), durationMs: 60_000 },
    },
  ],
  totals: costTotals(2_800_000_000_000),
  aggregates: {
    sessionCount: 4_212,
    longestSessionDurationMs: (59 * 60 + 4) * 60 * 1000,
    messages: {
      total: 2_787_815,
      user: 1_400_000,
      assistant: 1_387_815,
      toolCalls: 42_380,
      toolResults: 42_380,
      errors: 12,
    },
    tools: {
      totalCalls: 42_380,
      uniqueTools: 205,
      tools: [
        { name: "exec", count: 6_418 },
        { name: "browser", count: 5_256 },
        { name: "message", count: 4_708 },
      ],
    },
    byModel: [
      {
        provider: "anthropic",
        model: "claude-opus-4-8",
        count: 9_000,
        totals: costTotals(2_000_000_000_000),
      },
      { provider: "openai", model: "gpt-5.5", count: 2_000, totals: costTotals(800_000_000_000) },
    ],
    byProvider: [],
    byAgent: [{ agentId: "main", totals: costTotals(2_800_000_000_000) }],
    byChannel: [
      { channel: "whatsapp", totals: costTotals(1_500_000_000_000) },
      { channel: "telegram", totals: costTotals(900_000_000_000) },
      { channel: "discord", totals: costTotals(400_000_000_000) },
    ],
    daily: [],
  },
};

describeControlUiE2e("Control UI profile page mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
      );
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  async function openProfilePage(page: Page) {
    await installMockGateway(page, {
      methodResponses: {
        "usage.cost": usageCostResponse,
        "sessions.usage": sessionsUsageResponse,
      },
    });
    const response = await page.goto(`${server.baseUrl}settings/profile`);
    expect(response?.status()).toBe(200);
  }

  it("renders hero identity, lifetime stats, heatmap, and insights", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await openProfilePage(page);

      await page.locator(".profile-hero__name").waitFor({ timeout: 10_000 });
      await expect(page.locator(".profile-hero__name").textContent()).resolves.toContain(
        "OpenClaw",
      );
      await expect(page.locator(".profile-hero__handle").textContent()).resolves.toContain("@main");
      // No avatar configured: the lobster mascot fills in.
      await page.locator(".profile-hero__avatar-mascot svg").waitFor({ timeout: 5_000 });
      const chips = await page.locator(".profile-hero__chip").allTextContents();
      expect(chips.some((chip) => chip.includes("In the reef since"))).toBe(true);
      expect(chips.some((chip) => chip.includes("Whatsapp"))).toBe(true);

      const statValues = await page.locator(".profile-stats__value").allTextContents();
      expect(statValues[0]?.trim()).toBe("2.8T");
      expect(statValues[1]?.trim()).toBe("82.1B");
      expect(statValues[2]?.trim()).toBe("2d 11h");
      expect(statValues[3]?.trim()).toBe("3 days");

      const cellCount = await page.locator(".profile-heatmap__svg rect").count();
      expect(cellCount).toBe(52 * 7);

      const insightValues = await page.locator(".settings-kv dd").allTextContents();
      expect(insightValues[0]?.trim()).toBe("claude-opus-4-8");
      expect(insightValues.some((value) => value.replace(/[^0-9]/gu, "") === "2787815")).toBe(true);

      const toolNames = await page.locator(".profile-tools__name").allTextContents();
      expect(toolNames.map((name) => name.trim())).toEqual(["exec", "browser", "message"]);
    } finally {
      await context.close();
    }
  });

  it("renders the gateway avatar route in the profile preview", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const avatarRequests: string[] = [];
    // The gateway serves the avatar (uploaded first, Gravatar fallback second)
    // behind its own same-origin route; the Control UI renders only that route,
    // so the preview never requests gravatar.com directly — the Control UI CSP
    // (img-src 'self') would block it.
    await page.route("**/api/users/profile-1/avatar*", async (route) => {
      avatarRequests.push(route.request().url());
      await route.fulfill({
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
        contentType: "image/svg+xml",
        status: 200,
      });
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "usage.cost": usageCostResponse,
        "sessions.usage": sessionsUsageResponse,
        "users.self": {
          profile: {
            id: "profile-1",
            displayName: "Test Person",
            avatarMime: null,
            mergedInto: null,
            createdAt: 1,
            updatedAt: 2,
            emails: ["test@example.com"],
            hasAvatar: false,
          },
        },
      },
    });

    try {
      const response = await page.goto(`${server.baseUrl}settings/profile`);
      expect(response?.status()).toBe(200);
      const connect = await gateway.waitForRequest("connect");
      const instanceId = (connect.params as { client?: { instanceId?: string } } | undefined)
        ?.client?.instanceId;
      expect(instanceId).toBeTruthy();
      await gateway.emitGatewayEvent("presence", {
        presence: [
          {
            instanceId,
            user: { id: "profile-1", email: "test@example.com", name: "Test Person" },
          },
        ],
      });

      const profileAvatar = page.locator("#settings-profile-identity openclaw-viewer-avatar img");
      await profileAvatar.waitFor({ timeout: 10_000 });
      // profile-page derives the src from userProfileAvatarUrl(id, updatedAt);
      // the gateway origin may absolutize it, so match the canonical path suffix.
      expect(await profileAvatar.getAttribute("src")).toMatch(
        /\/api\/users\/profile-1\/avatar\?v=2$/u,
      );
      await expect
        .poll(() => avatarRequests.some((url) => url.includes("/api/users/profile-1/avatar")))
        .toBe(true);
    } finally {
      await context.close();
    }
  });

  it("keeps the loading note while a cold usage cache is still rebuilding", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await installMockGateway(page, {
        methodResponses: {
          "usage.cost": {
            updatedAt: Date.now(),
            days: 0,
            daily: [],
            totals: costTotals(0),
            cacheStatus: { status: "refreshing", cachedFiles: 0, pendingFiles: 12, staleFiles: 0 },
          },
          "sessions.usage": { ...sessionsUsageResponse, sessions: [], totals: costTotals(0) },
        },
      });
      const response = await page.goto(`${server.baseUrl}settings/profile`);
      expect(response?.status()).toBe(200);

      await page.locator(".settings-empty").waitFor({ timeout: 10_000 });
      // Zero totals with a refreshing cache must not claim a fresh shell.
      await expect(page.locator(".settings-empty strong").count()).resolves.toBe(0);
      await expect(page.locator(".settings-empty").textContent()).resolves.toContain(
        "Diving for stats",
      );
    } finally {
      await context.close();
    }
  });

  it("shows the fresh-shell empty state when no tokens were spent", async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await installMockGateway(page, {
        methodResponses: {
          "usage.cost": {
            updatedAt: Date.now(),
            days: 0,
            daily: [],
            totals: costTotals(0),
          },
          "sessions.usage": {
            ...sessionsUsageResponse,
            sessions: [],
            totals: costTotals(0),
          },
        },
      });
      const response = await page.goto(`${server.baseUrl}settings/profile`);
      expect(response?.status()).toBe(200);

      await page.locator(".settings-empty strong").waitFor({ timeout: 10_000 });
      await expect(page.locator(".settings-empty strong").textContent()).resolves.toContain(
        "A fresh shell",
      );
      await expect(page.locator(".profile-heatmap__svg").count()).resolves.toBe(0);
    } finally {
      await context.close();
    }
  });
});

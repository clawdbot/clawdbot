import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI usage cost analysis mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

const recordVisuals = process.env.OPENCLAW_UI_E2E_RECORD === "1";

const totals = {
  input: 1_200_000,
  output: 300_000,
  cacheRead: 2_400_000,
  cacheWrite: 100_000,
  totalTokens: 4_000_000,
  totalCost: 32,
  inputCost: 12,
  outputCost: 12,
  cacheReadCost: 6,
  cacheWriteCost: 2,
  missingCostEntries: 0,
};

const emptyTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  totalCost: 0,
  inputCost: 0,
  outputCost: 0,
  cacheReadCost: 0,
  cacheWriteCost: 0,
  missingCostEntries: 0,
};

function dayOffset(offset: number): string {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() + offset);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dailyEntry(offset: number, totalCost: number, totalTokens: number) {
  return {
    ...totals,
    date: dayOffset(offset),
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    totalCost,
    inputCost: totalCost,
    outputCost: 0,
    cacheReadCost: 0,
    cacheWriteCost: 0,
  };
}

const daily = [
  dailyEntry(-89, 5, 500_000),
  dailyEntry(-29, 7, 700_000),
  dailyEntry(-6, 9, 900_000),
  dailyEntry(0, 11, 1_100_000),
];

function emptyUsageResponses() {
  const updatedAt = Date.now();
  const date = dayOffset(0);
  return {
    "sessions.usage": {
      updatedAt,
      startDate: date,
      endDate: date,
      sessions: [],
      totals: emptyTotals,
      aggregates: {
        messages: { total: 0, user: 0, assistant: 0, toolCalls: 0, toolResults: 0, errors: 0 },
        tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
        byModel: [],
        byProvider: [],
        byAgent: [],
        byChannel: [],
        daily: [],
      },
    },
    "usage.cost": { updatedAt, days: 1, daily: [], totals: emptyTotals },
  };
}

suite.define(() => {
  it.each(["recent-sort", "filtered", "recent-tab"])(
    "selects the visible session range with Shift-click (%s)",
    async (scenario) => {
      const updatedAt = Date.now();
      const sessions = [
        { label: "Visible A", tokens: 400 },
        { label: "Hidden", tokens: 300 },
        { label: "Visible B", tokens: 100 },
        { label: "Visible C", tokens: 200 },
      ].map(({ label, tokens }, index) => ({
        key: `agent:main:range-${index}`,
        label,
        agentId: "main",
        updatedAt: updatedAt - index,
        usage: { ...emptyTotals, input: tokens, totalTokens: tokens },
      }));
      const empty = emptyUsageResponses();
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { height: 1_000, width: 1_440 } },
        async ({ page }) => {
          await installMockGateway(page, {
            methodResponses: {
              ...empty,
              "sessions.usage": { ...empty["sessions.usage"], sessions },
              "sessions.usage.timeseries": { points: [] },
              "sessions.usage.logs": { logs: [] },
              "usage.status": { updatedAt, providers: [] },
            },
          });
          await page.goto(`${suite.server.baseUrl}usage`);
          const card = page.locator(".sessions-card");
          let list = card.locator(".session-bars").first();
          await expect
            .poll(() => list.locator(".session-bar-title").allTextContents())
            .toEqual(sessions.map((session) => session.label));
          if (scenario === "filtered") {
            await page.locator(".usage-query-input").fill("label:Visible");
            await page.locator(".usage-query-input").press("Enter");
            await expect.poll(() => list.locator(".session-bar-row").count()).toBe(3);
          }
          if (scenario === "recent-tab") {
            for (const name of ["Visible C", "Visible A", "Visible B"]) {
              await list.getByRole("button", { name, exact: true }).click();
            }
            await card.getByRole("button", { name: "Recently viewed", exact: true }).click();
            list = card.locator(".session-bars--recent");
            await expect
              .poll(() => list.locator(".session-bar-title").allTextContents())
              .toEqual(["Visible B", "Visible A", "Visible C"]);
            await card.getByRole("button", { name: "Clear Selection", exact: true }).click();
          }
          const names = await list.locator(".session-bar-title").allTextContents();
          await list.getByRole("button", { name: names[0], exact: true }).click();
          await list
            .getByRole("button", { name: "Visible C", exact: true })
            .click({ modifiers: ["Shift"] });
          if (recordVisuals) {
            const artifactDir = path.join(suite.artifactDir, "usage-range-selection");
            await card.screenshot({ path: path.join(artifactDir, `${scenario}.png`) });
          }
          await expect
            .poll(async () =>
              (
                await list.locator('[aria-pressed="true"] .session-bar-title').allTextContents()
              ).toSorted(),
            )
            .toEqual(names.toSorted());
          if (scenario === "filtered") {
            await page.locator(".usage-query-input").fill("");
            await page.locator(".usage-query-input").press("Enter");
            await expect.poll(() => list.locator(".session-bar-row").count()).toBe(4);
            await expect
              .poll(() =>
                list
                  .getByRole("button", { name: "Hidden", exact: true })
                  .getAttribute("aria-pressed"),
              )
              .toBe("false");
          }
        },
      );
    },
  );

  it("shows a visible provider usage warning when the usage status request fails", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...emptyUsageResponses(),
            "usage.status": {
              __mockError: { code: "INTERNAL_ERROR", message: "gateway transport unavailable" },
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}usage`);
        await expect
          .poll(async () => (await gateway.getRequests("usage.status")).length)
          .toBeGreaterThan(0);
        await page.locator(".usage-empty-state").waitFor();
        await expect
          .poll(() => page.locator(".usage-page").textContent())
          .toContain("Provider usage is unavailable; the last request failed. Refresh to retry.");
        if (recordVisuals) {
          await mkdir(path.join(suite.artifactDir, "provider-usage-outcomes"), { recursive: true });
          await page.locator(".usage-page").screenshot({
            animations: "disabled",
            path: path.join(
              path.join(suite.artifactDir, "provider-usage-outcomes"),
              "usage-status-request-failed.png",
            ),
          });
        }
      },
    );
  });

  it("does not show the provider usage warning for a valid empty response", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...emptyUsageResponses(),
            "usage.status": { updatedAt: Date.now(), providers: [] },
          },
        });

        await page.goto(`${suite.server.baseUrl}usage`);
        await expect
          .poll(async () => (await gateway.getRequests("usage.status")).length)
          .toBeGreaterThan(0);
        await page.locator(".usage-empty-state").waitFor();
        await expect
          .poll(() => page.locator(".usage-page").textContent())
          .not.toContain(
            "Provider usage is unavailable; the last request failed. Refresh to retry.",
          );
        if (recordVisuals) {
          await mkdir(path.join(suite.artifactDir, "provider-usage-outcomes"), { recursive: true });
          await page.locator(".usage-page").screenshot({
            animations: "disabled",
            path: path.join(
              path.join(suite.artifactDir, "provider-usage-outcomes"),
              "usage-status-empty.png",
            ),
          });
        }
      },
    );
  });

  it("keeps pending sessions visible when their UTC activity day is selected", async () => {
    const selectedDay = "2026-05-14";
    const updatedAt = Date.parse("2026-05-14T00:30:00.000Z");
    const pendingSessionKey = "agent:main:pending-cache";
    const cachedSessionKey = "agent:main:cached-usage";
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        timezoneId: "America/Los_Angeles",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt,
              startDate: selectedDay,
              endDate: selectedDay,
              sessions: [
                {
                  key: cachedSessionKey,
                  label: "Cached session",
                  agentId: "main",
                  updatedAt,
                  usage: {
                    ...totals,
                    activityDates: [selectedDay],
                    dailyBreakdown: [
                      { date: selectedDay, cost: totals.totalCost, tokens: totals.totalTokens },
                    ],
                  },
                },
                {
                  key: pendingSessionKey,
                  label: "Pending session",
                  agentId: "main",
                  updatedAt,
                  usage: null,
                },
              ],
              totals,
              aggregates: {
                messages: {
                  total: 0,
                  user: 0,
                  assistant: 0,
                  toolCalls: 0,
                  toolResults: 0,
                  errors: 0,
                },
                tools: { totalCalls: 0, uniqueTools: 0, tools: [] },
                byModel: [],
                byProvider: [],
                byAgent: [{ agentId: "main", totals }],
                byChannel: [],
                daily: [
                  {
                    date: selectedDay,
                    tokens: totals.totalTokens,
                    cost: totals.totalCost,
                    messages: 0,
                    toolCalls: 0,
                    errors: 0,
                  },
                ],
              },
              cacheStatus: { status: "refreshing", cachedFiles: 1, pendingFiles: 1, staleFiles: 0 },
            },
            "usage.cost": {
              updatedAt,
              days: 1,
              daily: [{ ...totals, date: selectedDay }],
              totals,
            },
            "usage.status": { updatedAt, providers: [] },
          },
        });

        await page.goto(`${suite.server.baseUrl}usage`);
        const pendingRow = page.locator(".session-bar-row").filter({ hasText: "Pending session" });
        const cachedRow = page.locator(".session-bar-row").filter({ hasText: "Cached session" });
        await expect.poll(() => pendingRow.count(), { timeout: 10_000 }).toBe(1);

        await page.locator(".usage-select").selectOption("utc");
        await expect
          .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
          .toMatchObject({ mode: "utc" });
        await expect.poll(() => cachedRow.count(), { timeout: 10_000 }).toBe(1);
        await page.locator(".daily-bar-wrapper").click();

        await expect.poll(() => cachedRow.count()).toBe(1);
        await expect.poll(() => pendingRow.count()).toBe(1);
      },
    );
  });

  it("keeps selected provider alternatives visible and finds quoted session labels", async () => {
    const date = dayOffset(0);
    const updatedAt = Date.now();
    const sessions = [
      { provider: "openai", label: "Team Planning" },
      { provider: "anthropic", label: "Research Review" },
    ].map(({ provider, label }) => ({
      key: `agent:main:${provider}`,
      label,
      agentId: "main",
      modelProvider: provider,
      model: `${provider}-model`,
      updatedAt,
      usage: {
        ...totals,
        activityDates: [date],
        dailyBreakdown: [{ date, cost: totals.totalCost, tokens: totals.totalTokens }],
      },
    }));
    const empty = emptyUsageResponses();
    if (recordVisuals) {
      await mkdir(path.join(suite.artifactDir, "usage-filter-repair"), { recursive: true });
    }

    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
        ...(recordVisuals
          ? {
              recordVideo: {
                dir: path.join(suite.artifactDir, "usage-filter-repair"),
                size: { height: 1_000, width: 1_440 },
              },
            }
          : {}),
      },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": { ...empty["sessions.usage"], sessions, totals },
            "usage.cost": {
              ...empty["usage.cost"],
              daily: [dailyEntry(0, totals.totalCost, totals.totalTokens)],
              totals,
            },
            "usage.status": { updatedAt, providers: [] },
          },
        });

        await page.goto(`${suite.server.baseUrl}usage`);
        const sessionLabels = page.locator(".session-bar-title");
        await expect
          .poll(async () => (await sessionLabels.allTextContents()).toSorted())
          .toEqual(["Research Review", "Team Planning"]);

        const providerFilter = page.locator(".usage-filter-select").filter({
          has: page.locator(".usage-filter-trigger", { hasText: "Provider" }),
        });
        await providerFilter.locator(".usage-filter-trigger").click();
        await providerFilter.locator('wa-dropdown-item[value="command:select-all"]').click();
        await expect.poll(() => providerFilter.locator(".settings-count").textContent()).toBe("2");
        await expect
          .poll(async () => (await sessionLabels.allTextContents()).toSorted())
          .toEqual(["Research Review", "Team Planning"]);
        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "usage-filter-repair"),
              "01-provider-alternatives.png",
            ),
          });
        }

        const query = page.locator(".usage-query-input");
        await query.fill('label:"Team Planning"');
        await query.press("Enter");
        await expect.poll(() => sessionLabels.allTextContents()).toEqual(["Team Planning"]);
        if (recordVisuals) {
          await page.screenshot({
            animations: "disabled",
            fullPage: true,
            path: path.join(
              path.join(suite.artifactDir, "usage-filter-repair"),
              "02-quoted-session-label.png",
            ),
          });
        }
      },
    );
  });

  it("renders cost analysis from Gateway usage data", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 1_000, width: 1_440 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "agents.list": {
              agents: [
                { id: "main", name: "Main" },
                { id: "writer", name: "Writer" },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "sessions.usage": {
              updatedAt: Date.now(),
              startDate: dayOffset(-89),
              endDate: dayOffset(0),
              sessions: [
                {
                  key: "agent:main:cost-analysis",
                  label: "Cost analysis",
                  agentId: "main",
                  modelProvider: "openai",
                  model: "gpt-5.5",
                  updatedAt: Date.now(),
                  usage: {
                    ...totals,
                    activityDates: daily.map((entry) => entry.date),
                    dailyBreakdown: daily.map((entry) => ({
                      date: entry.date,
                      cost: entry.totalCost,
                      tokens: entry.totalTokens,
                    })),
                    messageCounts: {
                      total: 40,
                      user: 20,
                      assistant: 20,
                      toolCalls: 12,
                      toolResults: 12,
                      errors: 0,
                    },
                    modelUsage: [
                      {
                        provider: "openai",
                        model: "gpt-5.5",
                        count: 30,
                        totals: { ...totals, totalCost: 22 },
                      },
                      {
                        provider: "anthropic",
                        model: "claude-opus-4-6",
                        count: 10,
                        totals: { ...totals, totalCost: 10 },
                      },
                    ],
                  },
                },
              ],
              totals,
              aggregates: {
                messages: {
                  total: 40,
                  user: 20,
                  assistant: 20,
                  toolCalls: 12,
                  toolResults: 12,
                  errors: 0,
                },
                tools: { totalCalls: 12, uniqueTools: 2, tools: [{ name: "exec", count: 8 }] },
                byModel: [
                  {
                    provider: "openai",
                    model: "gpt-5.5",
                    count: 30,
                    totals: { ...totals, totalCost: 22 },
                  },
                  {
                    provider: "anthropic",
                    model: "claude-opus-4-6",
                    count: 10,
                    totals: { ...totals, totalCost: 10 },
                  },
                ],
                byProvider: [
                  { provider: "openai", count: 30, totals: { ...totals, totalCost: 22 } },
                  { provider: "anthropic", count: 10, totals: { ...totals, totalCost: 10 } },
                ],
                byAgent: [{ agentId: "main", totals }],
                byChannel: [],
                daily: daily.map((entry) => ({
                  date: entry.date,
                  tokens: entry.totalTokens,
                  cost: entry.totalCost,
                  messages: 10,
                  toolCalls: 3,
                  errors: 0,
                })),
              },
            },
            "usage.cost": {
              updatedAt: Date.now(),
              days: 90,
              daily,
              totals,
            },
            "usage.status": {
              updatedAt: Date.now(),
              providers: [
                {
                  provider: "openai",
                  displayName: "OpenAI",
                  plan: "Admin API",
                  windows: [],
                  billing: [
                    { type: "spend", label: "30-day API spend", amount: 98.75, unit: "USD" },
                  ],
                  costHistory: {
                    unit: "USD",
                    periodDays: 30,
                    daily: [
                      {
                        date: dayOffset(-6),
                        amount: 38.5,
                        requests: 12_300,
                        inputTokens: 4_200_000,
                        cacheReadTokens: 2_100_000,
                        cacheWriteTokens: 0,
                        outputTokens: 850_000,
                        totalTokens: 5_050_000,
                      },
                      {
                        date: dayOffset(0),
                        amount: 60.25,
                        requests: 18_450,
                        inputTokens: 6_100_000,
                        cacheReadTokens: 3_400_000,
                        cacheWriteTokens: 0,
                        outputTokens: 1_200_000,
                        totalTokens: 7_300_000,
                      },
                    ],
                    models: [
                      {
                        name: "gpt-5.5",
                        requests: 30_750,
                        inputTokens: 10_300_000,
                        cacheReadTokens: 5_500_000,
                        cacheWriteTokens: 0,
                        outputTokens: 2_050_000,
                        totalTokens: 12_350_000,
                      },
                    ],
                    categories: [{ name: "Responses", amount: 98.75 }],
                  },
                },
                {
                  provider: "anthropic",
                  displayName: "Anthropic",
                  plan: "Admin API",
                  windows: [],
                  billing: [
                    { type: "spend", label: "30-day API spend", amount: 42.4, unit: "USD" },
                  ],
                  costHistory: {
                    unit: "USD",
                    periodDays: 30,
                    daily: [
                      {
                        date: dayOffset(-6),
                        amount: 17.15,
                        inputTokens: 1_800_000,
                        cacheReadTokens: 900_000,
                        cacheWriteTokens: 200_000,
                        outputTokens: 350_000,
                        totalTokens: 3_250_000,
                      },
                      {
                        date: dayOffset(0),
                        amount: 25.25,
                        inputTokens: 2_600_000,
                        cacheReadTokens: 1_400_000,
                        cacheWriteTokens: 300_000,
                        outputTokens: 500_000,
                        totalTokens: 4_800_000,
                      },
                    ],
                    models: [
                      {
                        name: "claude-opus-4-8",
                        inputTokens: 4_400_000,
                        cacheReadTokens: 2_300_000,
                        cacheWriteTokens: 500_000,
                        outputTokens: 850_000,
                        totalTokens: 8_050_000,
                      },
                    ],
                    categories: [{ name: "Claude API", amount: 42.4 }],
                  },
                },
                {
                  provider: "openrouter",
                  displayName: "OpenRouter",
                  plan: "Production",
                  windows: [{ label: "API key budget", usedPercent: 25 }],
                  billing: [
                    {
                      type: "balance",
                      label: "Account balance",
                      amount: 64.5,
                      unit: "USD",
                    },
                    {
                      type: "budget",
                      label: "API key budget",
                      used: 5,
                      limit: 20,
                      unit: "USD",
                    },
                  ],
                  summary: "$1.25 today · $5.00 this month",
                },
              ],
            },
          },
        });

        await page.goto(`${suite.server.baseUrl}usage`);
        await page.locator(".daily-chart-compact").waitFor({ state: "visible", timeout: 10_000 });
        const agentScope = page.locator(".agent-scope-control openclaw-agent-select");
        await agentScope.locator(".agent-select__trigger").click();
        await agentScope
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "All agents" })
          .click();
        await expect
          .poll(async () => (await gateway.getRequests("usage.cost")).at(-1)?.params)
          .toMatchObject({ agentScope: "all" });
        const costRequestsBeforeRangeChange = (await gateway.getRequests("usage.cost")).length;
        await page.getByRole("button", { name: "90d", exact: true }).click();
        await expect
          .poll(async () => (await gateway.getRequests("usage.cost")).length)
          .toBeGreaterThan(costRequestsBeforeRangeChange);
        await page.getByRole("button", { name: "Cost", exact: true }).click();

        const windowCards = page.locator(".cost-window-card");
        await expect.poll(() => windowCards.count()).toBe(4);
        await expect
          .poll(async () => ({
            labels: await windowCards.locator(".cost-window-card__label").allTextContents(),
            values: (await windowCards.locator(".cost-window-card__value").allTextContents()).map(
              (value) => value.trim(),
            ),
          }))
          .toEqual({
            labels: ["Selected Range", "Today", "Last 7 days", "Last 30 days"],
            values: ["$32.00", "$11.00", "$20.00", "$27.00"],
          });
        await expect
          .poll(() => page.locator(".daily-chart-scale span").allTextContents())
          .toEqual(["$11.00", "$5.50", "$0.00"]);
        await expect
          .poll(() =>
            page.locator(".usage-insight-card", { hasText: "Top Providers" }).textContent(),
          )
          .toContain("openai");
        const messagesHint = page.locator("#usage-summary-hint-messages");
        const messagesTooltipHost = messagesHint.locator("xpath=..");
        const messagesTooltip = messagesTooltipHost.locator("wa-tooltip");
        await messagesHint.hover();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
        await page.mouse.move(1, 1);
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();

        await page.keyboard.press("Tab");
        await messagesHint.focus();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
        await page.getByRole("button", { name: "Cost", exact: true }).focus();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();

        await messagesHint.click();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
        await expect
          .poll(() => messagesTooltipHost.locator('[slot="content"]').textContent())
          .toContain("Total user and assistant messages in range.");
        await page.getByRole("button", { name: "Cost", exact: true }).click();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();
        await page.keyboard.press("Tab");
        await messagesHint.focus();
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBe("");
        await messagesHint.press("Escape");
        await expect.poll(() => messagesTooltip.getAttribute("open")).toBeNull();
        const providerCards = page.locator(".provider-usage-card");
        await expect.poll(() => providerCards.count()).toBe(3);
        await expect
          .poll(async () => (await gateway.getRequests("usage.status")).length)
          .toBeGreaterThan(0);
        await expect
          .poll(() => providerCards.filter({ hasText: "OpenRouter" }).textContent())
          .toContain("$64.50");
        await expect
          .poll(() => providerCards.filter({ hasText: "OpenAI" }).textContent())
          .toContain("$98.75");
        await expect
          .poll(() => providerCards.filter({ hasText: "Anthropic" }).textContent())
          .toContain("claude-opus-4-8");

        await page.locator(".usage-query-input").fill("missing-session");
        await page.locator(".usage-query-input").press("Enter");
        const topProviders = page.locator(".usage-insight-card", { hasText: "Top Providers" });
        await expect.poll(() => topProviders.textContent()).toContain("No provider data");
        await expect.poll(() => topProviders.textContent()).not.toContain("openai");

        if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
          const artifactDir = path.join(suite.artifactDir, "provider-plans");
          await page.locator(".usage-page").screenshot({
            path: path.join(artifactDir, "after.png"),
          });
        }
      },
    );
  });
});

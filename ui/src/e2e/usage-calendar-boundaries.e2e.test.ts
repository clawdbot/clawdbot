import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Usage calendar boundaries" });

suite.define(() => {
  it("ends a local range at the next calendar midnight after a skipped midnight", async () => {
    const date = "2026-09-06";
    const updatedAt = Date.parse("2026-09-06T15:00:00Z");
    const totals = {
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    const points = [
      "2026-09-06T03:59:59.999Z",
      "2026-09-06T04:00:00.000Z",
      "2026-09-07T02:59:59.999Z",
      "2026-09-07T03:00:00.000Z",
      "2026-09-07T03:30:00.000Z",
    ].map((timestamp) => ({
      timestamp: Date.parse(timestamp),
      input: 100,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 100,
      cost: 0,
      cumulativeTokens: 100,
      cumulativeCost: 0,
    }));
    await suite.withPage(
      { locale: "en-US", timezoneId: "America/Santiago", serviceWorkers: "block" },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date(updatedAt));
        // Thread-local TZ cannot configure native Date; the browser context owns this zone.
        expect(
          await page.evaluate(() => {
            const start = new Date(2026, 8, 6);
            const end = new Date(2026, 8, 7);
            return [
              start.getHours(),
              end.getHours(),
              (end.getTime() - start.getTime()) / 3_600_000,
            ];
          }),
        ).toEqual([1, 0, 23]);
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.usage": {
              updatedAt,
              startDate: date,
              endDate: date,
              sessions: [
                {
                  key: "agent:main:skipped-midnight",
                  label: "Skipped midnight",
                  agentId: "main",
                  updatedAt,
                  usage: { ...totals, activityDates: [date] },
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
                byAgent: [],
                byChannel: [],
                daily: [],
              },
            },
            "usage.cost": { updatedAt, days: 1, daily: [{ date, ...totals }], totals },
            "usage.status": { updatedAt, providers: [] },
            "sessions.usage.timeseries": { points },
            "sessions.usage.logs": { logs: [] },
          },
        });
        await page.goto(`${suite.server.baseUrl}usage`);
        await page.locator(".usage-select").selectOption("local");
        const dateInputs = await page.locator(".usage-date-input").all();
        expect(dateInputs).toHaveLength(2);
        for (const input of dateInputs) {
          await input.fill(date);
          await input.press("Tab");
        }
        await expect
          .poll(async () => (await gateway.getRequests("sessions.usage")).at(-1)?.params)
          .toMatchObject({
            startDate: date,
            endDate: date,
            mode: "specific",
            timeZone: "America/Santiago",
          });
        await page.getByRole("button", { name: "Skipped midnight", exact: true }).click();
        await gateway.waitForRequest("sessions.usage.timeseries");
        const bars = page.locator(".session-detail-panel .ts-bar");
        await expect.poll(() => bars.count()).toBe(2);
        await expect
          .poll(() =>
            bars.evaluateAll((elements) =>
              elements.map((element) => element.getAttribute("aria-label")),
            ),
          )
          .toEqual([
            "Sep 6, 01:00 AM · 100 tokens · Out 0 · In 100 · CW 0 · CR 0",
            "Sep 6, 11:59 PM · 100 tokens · Out 0 · In 100 · CW 0 · CR 0",
          ]);
      },
    );
  });
});

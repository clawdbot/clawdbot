import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Usage selected-session details" });

suite.define(() => {
  it("counts assistant invocations and refreshes selected usage details", async () => {
    const date = "2026-08-20";
    const start = Date.parse(`${date}T12:00:00Z`);
    const totals = {
      input: 300,
      output: 60,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 360,
      totalCost: 0,
      inputCost: 0,
      outputCost: 0,
      cacheReadCost: 0,
      cacheWriteCost: 0,
      missingCostEntries: 0,
    };
    // The current whole-session producer groups repeated names within each message.
    const tools = {
      totalCalls: 2,
      uniqueTools: 2,
      tools: [
        { name: "read", count: 1 },
        { name: "exec", count: 1 },
      ],
    };
    const messages = { total: 3, user: 0, assistant: 3, toolCalls: 2, toolResults: 2, errors: 0 };
    const points = [start, start + 2000, start + 4000].map((timestamp, index) => ({
      timestamp,
      input: 100,
      output: 20,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 120,
      cost: 0,
      cumulativeTokens: 120 * (index + 1),
      cumulativeCost: 0,
    }));
    const artifactParent = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
    const proofDir = artifactParent
      ? createControlUiE2eArtifactDir("usage-tool-count", artifactParent)
      : undefined;
    await suite.withPage(
      {
        locale: "en-US",
        timezoneId: "UTC",
        serviceWorkers: "block",
        viewport: { width: 1440, height: 1000 },
      },
      async ({ page }) => {
        await page.clock.setFixedTime(new Date(start + 5000));
        const scenario = {
          methodResponses: {
            "sessions.usage": {
              updatedAt: start + 5000,
              startDate: date,
              endDate: date,
              sessions: [
                {
                  key: "agent:main:tool-count",
                  label: "Review two files",
                  agentId: "main",
                  updatedAt: start + 5000,
                  usage: {
                    ...totals,
                    activityDates: [date],
                    toolUsage: tools,
                    messageCounts: messages,
                  },
                },
              ],
              totals,
              aggregates: {
                messages,
                tools,
                byModel: [],
                byProvider: [],
                byAgent: [],
                byChannel: [],
                daily: [],
              },
            },
            "usage.cost": {
              updatedAt: start + 5000,
              days: 1,
              daily: [{ date, ...totals }],
              totals,
            },
            "usage.status": { updatedAt: start + 5000, providers: [] },
            "sessions.usage.timeseries": { points },
            "sessions.usage.logs": {
              logs: [
                { timestamp: start, role: "assistant", content: "[Tool: read]\n[Tool: read]" },
                {
                  timestamp: start + 500,
                  role: "toolResult",
                  content: "[Tool: read]\n[Tool Result]\nFirst file",
                },
                {
                  timestamp: start + 1000,
                  role: "toolResult",
                  content: "[Tool: read]\n[Tool Result]\nSecond file",
                },
                { timestamp: start + 2000, role: "assistant", content: "Both files reviewed." },
                { timestamp: start + 4000, role: "assistant", content: "[Tool: exec]" },
              ],
            },
          },
        };
        const gateway = await installMockGateway(page, scenario);
        await page.goto(`${suite.server.baseUrl}usage`);
        await page.getByRole("button", { name: "Review two files", exact: true }).click();
        await gateway.waitForRequest("sessions.usage.timeseries");
        await gateway.waitForRequest("sessions.usage.logs");
        const panel = page.locator(".session-detail-panel");
        const handle = panel.locator(".chart-handle-right");
        await handle.waitFor({ state: "visible" });
        await handle.scrollIntoViewIfNeeded();
        const handleBox = await handle.boundingBox();
        const chartBox = await panel.locator(".timeseries-svg").boundingBox();
        expect(handleBox).not.toBeNull();
        expect(chartBox).not.toBeNull();
        if (!handleBox || !chartBox) {
          throw new Error("Timeline drag handles did not render");
        }
        const y = handleBox.y + handleBox.height / 2;
        await page.mouse.move(handleBox.x + handleBox.width / 2, y);
        await page.mouse.down();
        await page.mouse.move(chartBox.x + (chartBox.width * (30 + 366 / 2)) / 400, y, {
          steps: 8,
        });
        await page.mouse.up();
        await panel.locator(".session-detail-indicator").waitFor({ state: "visible" });
        const count = panel.locator(".session-summary-value").nth(1);
        await expect.poll(() => panel.locator(".session-log-entry").count()).toBe(4);
        if (proofDir) {
          await panel.screenshot({ path: path.join(proofDir, "selected-range.png") });
        }
        await expect.poll(() => count.textContent()).toBe("2");
        const readRow = panel.locator(".usage-list-item").filter({ hasText: "read" });
        expect(await readRow.locator(".usage-list-value > span").first().textContent()).toBe("2");
        expect(await panel.locator(".session-log-tools-pill").first().textContent()).toContain(
          "read × 2",
        );
        await panel.getByRole("button", { name: "Reset", exact: true }).click();
        await expect.poll(() => panel.locator(".session-detail-indicator").count()).toBe(0);
        await expect.poll(() => panel.locator(".session-log-entry").count()).toBe(5);

        const refreshedTotals = { ...totals, input: 400, output: 80, totalTokens: 480 };
        const usage = scenario.methodResponses["sessions.usage"];
        const session = usage.sessions[0]!;
        const latestReply = "The newly completed reply is included after Refresh.";
        await page.clock.setFixedTime(new Date(start + 7000));
        await gateway.setMethodResponse("sessions.usage", {
          ...usage,
          updatedAt: start + 7000,
          sessions: [
            {
              ...session,
              updatedAt: start + 7000,
              usage: {
                ...session.usage,
                ...refreshedTotals,
                messageCounts: { ...messages, total: 4, assistant: 4 },
              },
            },
          ],
          totals: refreshedTotals,
        });
        await gateway.setMethodResponse("usage.cost", {
          ...scenario.methodResponses["usage.cost"],
          updatedAt: start + 7000,
          daily: [{ date, ...refreshedTotals }],
          totals: refreshedTotals,
        });
        await gateway.setMethodResponse("sessions.usage.timeseries", {
          points: [...points, { ...points[2]!, timestamp: start + 6000, cumulativeTokens: 480 }],
        });
        await gateway.setMethodResponse("sessions.usage.logs", {
          logs: [
            ...scenario.methodResponses["sessions.usage.logs"].logs,
            { timestamp: start + 6000, role: "assistant", content: latestReply },
          ],
        });
        await page.getByRole("button", { name: "Refresh", exact: true }).click();
        await expect
          .poll(() => panel.locator(".session-detail-stats").textContent())
          .toContain("480");
        const readDetails = async () => ({
          timeline: await panel.locator(".timeseries-summary").textContent(),
          conversation: await panel.locator(".session-log-content").allTextContents(),
        });
        try {
          await expect.poll(readDetails).toMatchObject({
            timeline: expect.stringContaining("480"),
            conversation: expect.arrayContaining([latestReply]),
          });
          for (const method of ["sessions.usage.timeseries", "sessions.usage.logs"]) {
            expect(await gateway.getRequests(method)).toHaveLength(2);
          }
        } finally {
          if (proofDir) {
            await panel.locator(".timeseries-summary").scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(proofDir, "manual-refresh.png") });
            await panel.locator(".session-log-entry").last().scrollIntoViewIfNeeded();
            await page.screenshot({ path: path.join(proofDir, "manual-conversation.png") });
            await fs.writeFile(
              path.join(proofDir, "manual-refresh.json"),
              JSON.stringify(
                {
                  ...(await readDetails()),
                  timelineRequests: await gateway.getRequests("sessions.usage.timeseries"),
                  conversationRequests: await gateway.getRequests("sessions.usage.logs"),
                },
                null,
                2,
              ),
            );
          }
        }
      },
    );
  });
});

// Control UI browser proof covers explicit automation ownership across widened page scope.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { expect, it } from "vitest";
import { installMockGateway, type MockGatewayRequest } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron agent ownership E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`.`,
});

const requireRecord = createRequireRecord("record", "expected-object-value");

function requestParams(request: MockGatewayRequest): Record<string, unknown> {
  return requireRecord(request.params);
}

function cronListResponse(jobs: unknown[]) {
  return {
    jobs,
    snapshotRevision: "cron-agent-ownership-fixture",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

suite.define(() => {
  it("keeps the selected agent as owner while browsing all agents", async () => {
    const createdJob = {
      id: "weekday-report",
      agentId: "main",
      name: "Weekday report",
      enabled: true,
      createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
      updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
      schedule: { kind: "every", everyMs: 1_800_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Prepare the weekday report" },
      state: {},
    };
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          assistantName: "Assistant",
          methodResponses: {
            "agents.list": {
              agents: [
                { id: "main", identity: { name: "Assistant" }, name: "Assistant" },
                { id: "writer", identity: { name: "Writer" }, name: "Writer" },
              ],
              defaultId: "main",
              mainKey: "main",
              scope: "agent",
            },
            "cron.add": { id: createdJob.id },
            "cron.list": {
              cases: [
                { match: { lastRunStatus: "error" }, response: cronListResponse([]) },
                { response: cronListResponse([]) },
              ],
            },
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await gateway.waitForRequest("agents.list");
        const pageScope = page.locator(".agent-scope-control openclaw-agent-select");
        await pageScope.locator(".agent-select__trigger").click();
        await pageScope
          .locator("wa-dropdown-item[data-agent-option]")
          .filter({ hasText: "All agents" })
          .click();
        await expect
          .poll(() =>
            pageScope.evaluate((picker) => (picker as HTMLElement & { value: string }).value),
          )
          .toBe("");

        await page.locator('[data-test-id="cron-new-task"]').click();
        await page.locator("#cron-name").fill(createdJob.name);
        await page.locator("#cron-payload-text").fill(createdJob.payload.message);
        await gateway.setMethodResponse("cron.list", {
          cases: [
            { match: { lastRunStatus: "error" }, response: cronListResponse([]) },
            { response: cronListResponse([createdJob]) },
          ],
        });
        await page.locator('[data-test-id="cron-submit"]').click();

        expect(requestParams(await gateway.waitForRequest("models.list"))).toEqual({
          agentId: "main",
          view: "configured",
          preparedOnly: true,
        });
        expect(requestParams(await gateway.waitForRequest("cron.add"))).toMatchObject({
          agentId: "main",
          name: createdJob.name,
          payload: createdJob.payload,
        });
        await page
          .locator(".cron-table__name-text", { hasText: createdJob.name })
          .waitFor({ state: "visible", timeout: 10_000 });
      },
    );
  });
});

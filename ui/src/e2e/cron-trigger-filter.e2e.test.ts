// Control UI browser proof covers condition-trigger visibility and server-backed filtering.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron trigger filter E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const baseJob = {
  enabled: true,
  createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
  updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  state: {},
};
const conditionalJob = {
  ...baseJob,
  id: "conditional-job",
  configRevision: "conditional-revision",
  name: "Conditional job",
  payload: { kind: "systemEvent", text: "conditional" },
  trigger: { script: "json({ fire: true })" },
};
const plainJob = {
  ...baseJob,
  id: "plain-job",
  configRevision: "plain-revision",
  name: "Plain job",
  payload: { kind: "systemEvent", text: "plain" },
};

function listResponse(jobs: unknown[]) {
  return {
    jobs,
    snapshotRevision: `trigger-filter:${jobs.length}`,
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

suite.define(() => {
  it("shows trigger indicators and filters through cron.list before pagination", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": {
              cases: [
                { match: { lastRunStatus: "error" }, response: listResponse([]) },
                { match: { trigger: "conditional" }, response: listResponse([conditionalJob]) },
                { response: listResponse([conditionalJob, plainJob]) },
              ],
            },
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: 2, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        const conditionalRow = page.locator('[data-test-id="cron-row-conditional-job"]');
        await conditionalRow.waitFor();
        await page.locator('[data-test-id="cron-row-plain-job"]').waitFor();
        expect(await conditionalRow.locator(".cron-trigger-icon").getAttribute("aria-label")).toBe(
          "Trigger configured",
        );

        await page.locator(".cron-filter-popover__trigger").click();
        await page.locator('[data-test-id="cron-jobs-trigger-filter"]').selectOption("conditional");
        await expect
          .poll(async () =>
            (await gateway.getRequests("cron.list")).some(
              (request) =>
                request.params &&
                typeof request.params === "object" &&
                "trigger" in request.params &&
                request.params.trigger === "conditional",
            ),
          )
          .toBe(true);
        await expect
          .poll(async () => page.locator('[data-test-id="cron-row-plain-job"]').count())
          .toBe(0);
        expect(await conditionalRow.count()).toBe(1);
      },
    );
  });
});

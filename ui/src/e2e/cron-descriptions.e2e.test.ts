import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron saved descriptions E2E",
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

function cronJob(id: string, name: string) {
  return {
    id,
    name,
    enabled: true,
    createdAtMs: Date.parse("2026-05-29T08:00:00.000Z"),
    updatedAtMs: Date.parse("2026-05-29T08:05:00.000Z"),
    schedule: { kind: "every", everyMs: 60_000 },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
    payload: { kind: "systemEvent", text: `${name} fired` },
    state: {},
  };
}

suite.define(() => {
  it("shows saved descriptions in compact rows and task details for every payload kind", async () => {
    const jobs = [
      {
        ...cronJob("described-event", "System reminder"),
        description: "  Explain the system reminder without opening advanced settings  ",
        payload: { kind: "systemEvent", text: "Run the system reminder" },
      },
      {
        ...cronJob("described-agent", "Agent digest"),
        description: "Summarize the overnight activity",
        payload: { kind: "agentTurn", message: "List overnight deployment activity" },
      },
      {
        ...cronJob("described-command", "Command check"),
        description: "Run the infrastructure health check",
        payload: { kind: "command", argv: ["echo", "healthy"] },
      },
      {
        ...cronJob("described-script", "Script check"),
        description: "Inspect the scripted health check",
        payload: { kind: "script", script: "return 'healthy'" },
      },
      {
        ...cronJob("described-heartbeat", "Heartbeat check"),
        description: "Explain the system-owned heartbeat",
        payload: { kind: "heartbeat" },
      },
    ] as const;
    const undescribedJob = cronJob("without-description", "Plain task");
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: {
            "cron.list": {
              jobs: [...jobs, undescribedJob],
              snapshotRevision: "cron-descriptions-fixture",
              total: jobs.length + 1,
              offset: 0,
              limit: 50,
              hasMore: false,
              nextOffset: null,
            },
            "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
            "cron.status": { enabled: true, jobs: jobs.length + 1, nextWakeAtMs: null },
          },
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator(`[data-test-id="cron-row-${jobs[0].id}"]`).waitFor({ timeout: 10_000 });

        for (const job of jobs) {
          const description = page.locator(`[data-test-id="cron-row-description-${job.id}"]`);
          expect((await description.textContent())?.trim()).toBe(`· ${job.description.trim()}`);
          expect(await description.getAttribute("title")).toBe(
            `Description: ${job.description.trim()}`,
          );
        }
        expect(
          await page.locator(`[data-test-id="cron-row-description-${undescribedJob.id}"]`).count(),
        ).toBe(0);

        const describedRow = await page
          .locator(`[data-test-id="cron-row-${jobs[1].id}"]`)
          .boundingBox();
        const undescribedRow = await page
          .locator(`[data-test-id="cron-row-${undescribedJob.id}"]`)
          .boundingBox();
        expect(describedRow?.height).toBe(undescribedRow?.height);

        for (const job of jobs) {
          const row = page.locator(`[data-test-id="cron-row-${job.id}"]`);
          await row.locator(".cron-table__name-text").click();
          const detailDescription = page.locator('[data-test-id="cron-detail-description"]');
          await detailDescription.waitFor({ state: "visible" });
          expect((await detailDescription.textContent())?.replace(/\s+/g, " ").trim()).toBe(
            `Description: ${job.description.trim()}`,
          );

          await page.locator('[data-test-id="cron-detail-tab-history"]').click();
          expect((await detailDescription.textContent())?.replace(/\s+/g, " ").trim()).toBe(
            `Description: ${job.description.trim()}`,
          );
          await page.locator('[data-test-id="cron-back"]').click();
          await row.waitFor({ timeout: 10_000 });
        }
      },
    );
  });
});

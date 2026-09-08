import path from "node:path";
import { expect, it } from "vitest";
import type { CronJob, CronRunLogEntry } from "../api/types.ts";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron recorded delivery suppression",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("shows recorded suppression independently of delivery failure in both history views", async () => {
    const job: CronJob = {
      id: "delivery-history-proof",
      name: "Delivery history proof",
      enabled: true,
      createdAtMs: 1_000,
      updatedAtMs: 2_000,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Check for pending work." },
      delivery: { mode: "announce", channel: "last", bestEffort: true },
      state: {},
    };
    const entries: CronRunLogEntry[] = [
      {
        ts: 4_000,
        jobId: job.id,
        action: "finished",
        status: "ok",
        completionStatus: "succeeded",
        delivered: false,
        deliveryStatus: "not-delivered",
        deliverySuppressionReason: "silent",
        summary: "Polling completed.",
      },
      {
        ts: 3_000,
        jobId: job.id,
        action: "finished",
        status: "ok",
        completionStatus: "succeeded",
        delivered: false,
        deliveryStatus: "not-delivered",
        deliveryError: "Synthetic delivery target unavailable.",
        summary: "Polling completed.",
      },
    ];
    await suite.withPage(
      { locale: "en-US", viewport: { width: 1_280, height: 900 } },
      async ({ page }) => {
        const pageErrors: string[] = [];
        page.on("pageerror", (error) => pageErrors.push(error.message));
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": {
              jobs: [job],
              snapshotRevision: "delivery-history-proof",
              total: 1,
              offset: 0,
              limit: 50,
              nextOffset: null,
              hasMore: false,
            },
            "cron.runs": {
              entries,
              total: entries.length,
              offset: 0,
              limit: 50,
              nextOffset: null,
              hasMore: false,
            },
            "cron.status": { enabled: true, triggersEnabled: true, jobs: 1 },
          },
        });
        const response = await page.goto(`${suite.server.baseUrl}cron`);
        expect(response?.status()).toBe(200);
        await page.locator('[data-test-id="cron-list-tab-activity"]').click();

        for (const scope of ["all", "job"] as const) {
          if (scope === "job") {
            await page.locator('[data-test-id="cron-tab-all"]').click();
            await page
              .locator(`[data-test-id="cron-row-${job.id}"] .cron-table__name-text`)
              .click();
            await page.locator('[data-test-id="cron-detail-tab-history"]').click();
          }
          await expect
            .poll(async () =>
              (await gateway.getRequests("cron.runs")).some((request) => {
                const params = request.params as { scope?: string; id?: string };
                return params.scope === scope && (scope === "all" || params.id === job.id);
              }),
            )
            .toBe(true);
          const history = page.locator(scope === "all" ? ".cron-activity" : ".cron-history");
          await history.waitFor({ state: "visible" });
          const runs = history.locator(".cron-run-entry");
          await expect.poll(() => runs.count()).toBe(2);
          const suppressed = runs.nth(0);
          const failedDelivery = runs.nth(1);
          for (const run of [suppressed, failedDelivery]) {
            expect(await run.locator(".cron-run-entry__title").textContent()).toContain("OK");
            expect(await run.locator(".cron-run-entry__facts").textContent()).toContain(
              "Not delivered",
            );
            expect(await run.locator(".cron-run-entry__body").textContent()).toContain(
              "Polling completed.",
            );
          }
          expect(await failedDelivery.textContent()).toContain(
            "Synthetic delivery target unavailable.",
          );
          expect(await failedDelivery.textContent()).not.toContain("Delivery suppression:");
          expect(await suppressed.textContent()).not.toContain(
            "Synthetic delivery target unavailable.",
          );
          const artifactRoot = process.env.OPENCLAW_CONTROL_UI_E2E_ARTIFACT_DIR;
          const artifactDir = artifactRoot
            ? createControlUiE2eArtifactDir("cron-run-suppression", artifactRoot)
            : undefined;
          if (artifactDir) {
            // Only the synthetic suppressed row is captured, never the error row.
            await suppressed.screenshot({
              path: path.join(artifactDir, `${scope}-suppressed.png`),
            });
          }
          // Keep both consumers observable in the original failing run.
          expect
            .soft(await suppressed.textContent(), `${scope} recorded suppression`)
            .toContain("Delivery suppression: silent");
        }
        expect(pageErrors).toEqual([]);
      },
    );
  });
});

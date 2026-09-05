import fs from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI automation job links" });

suite.define(() => {
  it("opens a linked automation outside the first inventory page", async () => {
    const job = {
      id: "linked-automation",
      agentId: "writer",
      configRevision: "linked-definition",
      name: "Linked automation",
      enabled: true,
      createdAtMs: 1,
      updatedAtMs: 1,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "Produce the scheduled report." },
      state: {},
    };
    const jobs = Array.from({ length: 50 }, (_, index) => ({
      ...job,
      id: `other-${index}`,
      agentId: "main",
      name: `Other automation ${index}`,
    }));
    const run = {
      ts: 2,
      jobId: job.id,
      action: "finished",
      runId: "linked-run",
      status: "ok",
      summary: "Linked report completed.",
    };
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { width: 1280, height: 900 },
        recordVideo: { dir: suite.artifactDir, size: { width: 1280, height: 900 } },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.status": { enabled: true, jobs: 51, nextWakeAtMs: null },
            "cron.list": {
              jobs,
              total: 51,
              offset: 0,
              limit: 50,
              hasMore: true,
              nextOffset: 50,
              snapshotRevision: "linked-inventory",
            },
            "cron.get": job,
            "cron.runs": {
              cases: [
                {
                  match: { id: job.id },
                  response: {
                    entries: [run],
                    total: 1,
                    offset: 0,
                    limit: 50,
                    hasMore: false,
                    nextOffset: null,
                  },
                },
                {
                  response: {
                    entries: [],
                    total: 0,
                    offset: 0,
                    limit: 50,
                    hasMore: false,
                    nextOffset: null,
                  },
                },
              ],
            },
          },
        });
        try {
          await page.goto(`${suite.server.baseUrl}cron?job=${job.id}&run=${run.runId}`);
          await gateway.waitForRequest("cron.list");
          await expect.poll(() => page.locator(".cron-detail-title").textContent()).toBe(job.name);
          expect((await gateway.getRequests("cron.get")).map(({ params }) => params)).toEqual([
            { id: job.id },
          ]);
          await expect
            .poll(() => page.locator(".cron-run-entry--highlighted").textContent())
            .toContain(run.summary);
          const history = await gateway.getRequests("cron.runs");
          expect(history).toContainEqual(
            expect.objectContaining({
              params: expect.objectContaining({ id: job.id, scope: "job" }),
            }),
          );
          expect(history).not.toContainEqual(
            expect.objectContaining({
              params: expect.objectContaining({ id: job.id, agentId: expect.anything() }),
            }),
          );
        } finally {
          await fs.writeFile(
            path.join(suite.artifactDir, "linked-automation.png"),
            await takeControlUiViewportScreenshot(page, page.locator(".cron-page"), [
              page.locator(".cron-detail-title"),
            ]),
          );
          await fs.writeFile(
            path.join(suite.artifactDir, "gateway-requests.json"),
            JSON.stringify(await gateway.getRequests(), null, 2),
          );
        }
      },
    );
  });
});

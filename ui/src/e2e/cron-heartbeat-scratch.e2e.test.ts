import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI heartbeat scratch" });

const job = {
  id: "heartbeat-monitor",
  name: "Heartbeat (main)",
  enabled: true,
  createdAtMs: 1,
  updatedAtMs: 1,
  schedule: { kind: "every", everyMs: 1_800_000 },
  sessionTarget: "main",
  wakeMode: "next-heartbeat",
  payload: { kind: "heartbeat" },
  state: {},
};

const scratchContent = "# Heartbeat checklist\n\n- Inspect queued work.\n";
const scratchResponse = {
  scratch: { content: scratchContent, revision: 1, updatedAtMs: 1 },
  currentRevision: 1,
  maxBytes: 262_144,
};

function methodResponses(scratch: unknown = scratchResponse) {
  return {
    "cron.list": {
      jobs: [job],
      snapshotRevision: "heartbeat-scratch",
      total: 1,
      offset: 0,
      limit: 50,
      hasMore: false,
      nextOffset: null,
    },
    "cron.runs": { entries: [], total: 0, offset: 0, hasMore: false },
    "cron.scratch.get": scratch,
    "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
  };
}

suite.define(() => {
  it("shows authorized scratch in the read-only monitor without sending a write", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
        recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1_280 } },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: methodResponses(),
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator(`[data-test-id="cron-row-${job.id}"] .cron-table__name-text`).click();
        const monitor = page.locator("#cron-payload-text");
        await expect.poll(() => monitor.inputValue()).toBe(scratchContent);
        expect(await monitor.getAttribute("readonly")).toBe("");
        expect(await monitor.isEditable()).toBe(false);

        expect((await gateway.getRequests("cron.scratch.get")).map(({ params }) => params)).toEqual(
          [{ id: job.id }],
        );
        for (const method of ["cron.add", "cron.update", "cron.scratch.set"]) {
          expect(await gateway.getRequests(method)).toEqual([]);
        }
        await page.screenshot({
          path: path.join(suite.artifactDir, "heartbeat-monitor-scratch.png"),
          fullPage: true,
        });
      },
    );
  });

  it("does not request admin-only scratch for a read-only operator", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1_280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: methodResponses(),
          operatorScopes: ["operator.read"],
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        const row = page.locator(`[data-test-id="cron-row-${job.id}"]`);
        await row.waitFor();
        await row.locator(".cron-table__name-text").click();
        const monitor = page.locator("#cron-payload-text");
        await expect.poll(() => monitor.inputValue()).toBe("");
        expect(await gateway.getRequests("cron.scratch.get")).toEqual([]);
        for (const method of ["cron.add", "cron.update", "cron.scratch.set"]) {
          expect(await gateway.getRequests(method)).toEqual([]);
        }
      },
    );
  });

  it("shows a scratch read failure instead of an empty success state", async () => {
    const errorMessage = "Heartbeat scratch is temporarily unavailable.";
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1_280 } },
      async ({ page }) => {
        await installMockGateway(page, {
          methodResponses: methodResponses({
            __mockError: { code: "UNAVAILABLE", message: errorMessage },
          }),
        });

        await page.goto(`${suite.server.baseUrl}cron`);
        await page.locator(`[data-test-id="cron-row-${job.id}"] .cron-table__name-text`).click();
        await expect
          .poll(() => page.locator(".cron-error-banner").textContent())
          .toContain(errorMessage);
      },
    );
  });
});

import { writeFileSync } from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { expect, it } from "vitest";
import {
  installMockGateway,
  startControlUiE2eServer,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Cron loading mocked Gateway E2E",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const emptyList = {
  jobs: [],
  snapshotRevision: "cron-loading-empty",
  total: 0,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
};

function tableListRequests(requests: MockGatewayRequest[]) {
  return requests.filter(
    ({ params }) => isRecord(params) && params.scheduleKind === "all" && params.trigger === "all",
  );
}

suite.define(() => {
  it("bounds a held cron event burst and displays the completed run", async () => {
    const artifactDir = suite.artifactDir;
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
        recordVideo: { dir: artifactDir, size: { height: 900, width: 1_280 } },
      },
      async ({ page }) => {
        const summary = "Synthetic automation completed successfully";
        const runs = {
          entries: [
            {
              ts: Date.parse("2026-08-01T12:00:00Z"),
              jobId: "synthetic-job",
              action: "finished",
              status: "ok",
              summary,
            },
          ],
          total: 1,
          offset: 0,
          limit: 50,
          hasMore: false,
          nextOffset: null,
        };
        const gateway = await installMockGateway(page, {
          heldMethods: ["cron.status", "cron.runs"],
          methodResponses: {
            "cron.list": emptyList,
            "cron.runs": runs,
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });
        await page.goto(`${suite.server.baseUrl}cron`);
        await page.getByText("No automations yet").waitFor({ state: "visible" });
        await gateway.waitForRequest("cron.runs");
        await page.getByRole("tab", { name: "Run history", exact: true }).click();
        await page.screenshot({ path: path.join(artifactDir, "before-events.png") });
        const countRequests = async () => ({
          status: (await gateway.getRequests("cron.status")).length,
          runs: (await gateway.getRequests("cron.runs")).length,
        });
        const before = await countRequests();
        for (let index = 0; index < 20; index += 1) {
          await gateway.emitGatewayEvent("cron", { jobId: "synthetic-job", action: "finished" });
        }
        const held = await countRequests();
        writeFileSync(
          path.join(artifactDir, "requests.json"),
          JSON.stringify({ before, held }, null, 2),
        );
        await page.screenshot({ path: path.join(artifactDir, "held-event-burst.png") });
        expect(held).toEqual(before);
        await gateway.resolveDeferred("cron.status");
        await gateway.resolveDeferred("cron.runs");
        await page.getByText(summary).waitFor({ state: "visible" });
        await expect
          .poll(async () => (await gateway.getRequests("cron.runs")).length)
          .toBe(before.runs + 1);
        writeFileSync(
          path.join(artifactDir, "requests.json"),
          JSON.stringify({ before, held, completed: await countRequests() }, null, 2),
        );
        await page.screenshot({ path: path.join(artifactDir, "completed-run.png") });
      },
    );
  });

  it("shows pending before empty and keeps empty visible after a run-history failure", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          heldMethods: ["cron.list"],
          methodResponses: {
            "cron.list": emptyList,
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}cron`);
        expect(response?.status()).toBe(200);
        await gateway.waitForRequest("cron.list");

        const loading = page.locator('[data-test-id="cron-jobs-loading"]');
        await loading.waitFor({ state: "visible" });
        expect(await loading.getAttribute("role")).toBe("status");
        expect(await loading.getAttribute("aria-live")).toBe("polite");
        await expect.poll(() => loading.textContent()).toContain("Loading...");
        expect(await page.getByText("No automations yet").count()).toBe(0);
        expect(await page.locator(".cron-table").getAttribute("aria-busy")).toBe("true");
        expect(tableListRequests(await gateway.getRequests("cron.list"))).toHaveLength(1);

        await gateway.resolveDeferred("cron.list", emptyList);
        await page.getByText("No automations yet").waitFor({ state: "visible" });
        expect(await loading.count()).toBe(0);
        expect(await page.locator(".cron-table").getAttribute("aria-busy")).toBeNull();

        await gateway.setMethodResponse("cron.runs", {
          __mockError: { code: "UNAVAILABLE", message: "Run history unavailable." },
        });
        const previousTableRequests = tableListRequests(
          await gateway.getRequests("cron.list"),
        ).length;
        await page.getByRole("button", { name: "Refresh" }).click();

        await page.getByText("Run history unavailable.").waitFor({ state: "visible" });
        await page.getByText("No automations yet").waitFor({ state: "visible" });
        await expect
          .poll(async () => tableListRequests(await gateway.getRequests("cron.list")))
          .toHaveLength(previousTableRequests + 1);
      },
    );
  });
});

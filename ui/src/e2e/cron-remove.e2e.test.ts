// Control UI tests own the destructive Automation removal flow through the rendered page.
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway, waitForConfirmModal } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron removal mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}.`,
});

const job = {
  id: "nightly-digest",
  name: "Nightly digest",
  enabled: true,
  createdAtMs: Date.parse("2026-08-11T08:00:00.000Z"),
  updatedAtMs: Date.parse("2026-08-11T08:05:00.000Z"),
  schedule: { kind: "every", everyMs: 60_000 },
  sessionTarget: "isolated",
  wakeMode: "now",
  payload: { kind: "agentTurn", message: "Summarize the overnight activity" },
  state: {},
};

function cronListResponse(jobs: unknown[]) {
  return {
    jobs,
    snapshotRevision: jobs.length > 0 ? "cron-remove-present" : "cron-remove-empty",
    total: jobs.length,
    offset: 0,
    limit: 50,
    hasMore: false,
    nextOffset: null,
  };
}

async function chooseRemove(page: Page) {
  const menu = page.locator("wa-dropdown.cron-job-menu").first();
  await menu.locator(".cron-job-menu__trigger").click();
  await menu.locator('wa-dropdown-item[value="remove"]').click();
}

suite.define(() => {
  it("confirms removal and rejects a decision captured before reconnect", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1_280 },
      },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "cron.list": cronListResponse([job]),
            "cron.runs": { entries: [], total: 0, offset: 0, limit: 50, hasMore: false },
            "cron.status": { enabled: true, jobs: 1, nextWakeAtMs: null },
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}cron`);
        expect(response?.status()).toBe(200);
        const row = page.locator(`[data-test-id="cron-row-${job.id}"]`);
        await row.waitFor({ state: "visible", timeout: 10_000 });
        expect(await page.locator(".cron-table__head").getAttribute("role")).toBeNull();
        expect(await row.getAttribute("role")).toBeNull();
        const openTask = row.locator("button.cron-table__name");
        await openTask.focus();
        await page.keyboard.press("Enter");
        const detail = page.locator('.cron-page[data-panel-mode="job"]');
        await detail.waitFor({ state: "visible" });

        await chooseRemove(page);
        const cancelled = await waitForConfirmModal(page);
        await expect(cancelled.textContent()).resolves.toContain(job.name);
        await expect(cancelled.textContent()).resolves.toContain("permanently deletes");
        await expect(cancelled.textContent()).resolves.toContain("stops all future runs");
        expect(await cancelled.getByRole("checkbox").count()).toBe(0);
        await expect.poll(async () => gateway.getRequests("cron.remove")).toHaveLength(0);
        await cancelled.getByRole("button", { name: "Cancel" }).click();
        await expect.poll(async () => gateway.getRequests("cron.remove")).toHaveLength(0);
        await detail.waitFor({ state: "visible" });
        await expect
          .poll(() => detail.locator(".cron-detail-title").textContent())
          .toContain(job.name);

        await chooseRemove(page);
        const stale = await waitForConfirmModal(page);
        const socketCount = await gateway.getSocketCount();
        await gateway.closeLatest(1012, "Reconnect during automation removal confirmation");
        await expect.poll(() => gateway.getSocketCount()).toBeGreaterThan(socketCount);
        await stale.getByRole("button", { name: "Remove" }).click();
        await expect.poll(async () => gateway.getRequests("cron.remove")).toHaveLength(0);
        await row.waitFor({ state: "visible", timeout: 10_000 });

        await chooseRemove(page);
        const stable = await waitForConfirmModal(page);
        const remove = stable.getByRole("button", { name: "Remove" });
        await expect.poll(() => remove.getAttribute("class")).toContain("danger");
        await gateway.setMethodResponse("cron.list", cronListResponse([]));
        await remove.click();

        await expect.poll(async () => gateway.getRequests("cron.remove")).toHaveLength(1);
        expect((await gateway.getRequests("cron.remove"))[0]?.params).toEqual({ id: job.id });
        await expect.poll(() => row.count()).toBe(0);
      },
    );
  });
});

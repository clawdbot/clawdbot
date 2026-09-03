import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron run filter typography E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it("keeps dropdown text aligned at mobile and desktop widths", async () => {
    for (const viewport of [
      { height: 844, width: 390 },
      { height: 900, width: 1_280 },
    ]) {
      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport,
        },
        async ({ page }) => {
          const gateway = await installMockGateway(page, {
            methodResponses: {
              "cron.list": {
                jobs: [],
                snapshotRevision: "cron-run-filter-typography",
                total: 0,
                offset: 0,
                limit: 50,
                hasMore: false,
                nextOffset: null,
              },
              "cron.runs": {
                entries: [],
                total: 0,
                offset: 0,
                limit: 50,
                hasMore: false,
                nextOffset: null,
              },
              "cron.status": { enabled: true, jobs: 0, nextWakeAtMs: null },
            },
          });

          await page.goto(`${suite.server.baseUrl}cron`);
          await page.getByRole("tab", { name: "Run history", exact: true }).click();
          const labels = page.locator(".cron-run-filters .cron-filter-dropdown__trigger span");
          await expect.poll(() => labels.count()).toBe(3);
          const fontSizes = await labels.evaluateAll((elements) =>
            elements.map((element) => getComputedStyle(element).fontSize),
          );
          expect(new Set(fontSizes).size).toBe(1);

          await page.getByRole("button", { name: "Sort Newest first", exact: true }).click();
          await page.locator('wa-dropdown-item[value="asc"]').click();
          await page.getByRole("button", { name: "Sort Oldest first", exact: true }).waitFor();
          await expect
            .poll(async () =>
              (await gateway.getRequests("cron.runs")).some((request) => {
                const params = request.params;
                return (
                  typeof params === "object" &&
                  params !== null &&
                  "sortDir" in params &&
                  params.sortDir === "asc"
                );
              }),
            )
            .toBe(true);
        },
      );
    }
  });
});

// Control UI tests cover Automations form native-select display state.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI cron select values mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not installed or cannot start at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

suite.define(() => {
  it("shows the authoritative defaults in the create-form selects", async () => {
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
              jobs: [],
              snapshotRevision: "cron-select-values-fixture",
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

        const response = await page.goto(`${suite.server.baseUrl}cron`);
        expect(response?.status()).toBe(200);
        await page.locator('[data-test-id="cron-list-tab-activity"]').click();
        const sort = page.locator("select.cron-run-sort");
        await sort.waitFor({ state: "visible" });
        await sort.selectOption("asc");
        expect(await sort.inputValue()).toBe("asc");
        // Switching tabs recreates the select with the persisted non-first value.
        await page.locator('[data-test-id="cron-list-tab-tasks"]').click();
        await page.locator('[data-test-id="cron-list-tab-activity"]').click();
        expect(await page.locator("select.cron-run-sort").inputValue()).toBe("asc");
        await page.locator('[data-test-id="cron-new-task"]').click();

        const action = page.locator("select#cron-payload-kind");
        await action.waitFor({ state: "visible" });
        // Form defaults are agentTurn / isolated / minutes — none of which is
        // the first option of its select; the rendered selection must agree.
        expect(await action.inputValue()).toBe("agentTurn");
        expect(await page.locator("select#cron-session-target").inputValue()).toBe("isolated");
        expect(await page.locator('select[aria-label="Unit"]').inputValue()).toBe("minutes");
        // Control: delivery mode's default is also its first option.
        expect(await page.locator("select#cron-delivery-mode").inputValue()).toBe("announce");
      },
    );
  });
});

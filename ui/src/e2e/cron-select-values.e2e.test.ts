// Control UI tests cover Automations form select display state.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { pickerValue as readPickerValue } from "../test-helpers/select-picker-e2e.ts";
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
        const sortMenu = page.locator("wa-dropdown", { has: page.locator(".cron-run-sort") });
        const sort = page.getByRole("button", { name: "Sort Newest first", exact: true });
        await sort.waitFor({ state: "visible" });
        await sort.click();
        await sortMenu.locator('wa-dropdown-item[value="asc"]').click();
        await page.getByRole("button", { name: "Sort Oldest first", exact: true }).waitFor();
        // Switching tabs recreates the dropdown with the persisted non-first value.
        await page.locator('[data-test-id="cron-tab-all"]').click();
        await page.locator('[data-test-id="cron-list-tab-activity"]').click();
        await page.getByRole("button", { name: "Sort Oldest first", exact: true }).waitFor();
        expect(
          await sortMenu.locator('wa-dropdown-item[value="asc"]').getAttribute("aria-current"),
        ).toBe("true");
        await page.locator('[data-test-id="cron-new-task"]').click();

        const pickerValue = (selector: string) =>
          readPickerValue(page.locator(`openclaw-select-picker:has(${selector})`));
        const action = page.locator("#cron-payload-kind");
        await action.waitFor({ state: "visible" });
        // Form defaults are agentTurn / isolated / minutes — none of which is
        // the first option of its select; the rendered selection must agree.
        expect(await pickerValue("#cron-payload-kind")).toBe("agentTurn");
        expect(await pickerValue("#cron-session-target")).toBe("isolated");
        const unit = page.locator("openclaw-select-picker").filter({
          has: page.getByRole("button", { name: /^Unit: /u }),
        });
        expect(await readPickerValue(unit)).toBe("minutes");
        expect(await pickerValue("#cron-delivery-mode")).toBe("none");
        expect(await page.locator("#cron-delivery-channel").count()).toBe(0);

        await action.click();
        await page.getByRole("option", { name: "Post to main timeline", exact: true }).click();
        await expect.poll(() => pickerValue("#cron-payload-kind")).toBe("systemEvent");
        await expect.poll(() => pickerValue("#cron-session-target")).toBe("main");

        const target = page.locator("#cron-session-target");
        await target.click();
        await page.getByRole("option", { name: "Isolated session", exact: true }).click();
        await expect.poll(() => pickerValue("#cron-session-target")).toBe("isolated");
        await expect.poll(() => pickerValue("#cron-payload-kind")).toBe("agentTurn");
      },
    );
  });
});

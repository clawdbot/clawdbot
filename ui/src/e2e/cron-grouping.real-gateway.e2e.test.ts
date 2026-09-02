// Control UI proof exercises automation grouping and tagging through a real Gateway.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { loadCronStore } from "../../../src/cron/store.ts";
import type { GatewayServer } from "../../../src/gateway/server-public.ts";
import { createOpenClawTestState } from "../../../src/test-utils/openclaw-test-state.ts";
import { getFreePort } from "../../../src/test-utils/ports.ts";
import { waitForControlUiGatewayReady } from "../test-helpers/control-ui-e2e-readiness.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI automation grouping with a real Gateway",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}`,
});

suite.define(() => {
  it("creates, filters, clears, and persists automation metadata", async () => {
    const port = await getFreePort();
    const state = await createOpenClawTestState({
      label: "control-ui-cron-grouping",
      layout: "home",
      env: {
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    let gateway: GatewayServer | undefined;
    try {
      await mkdir(state.workspaceDir, { recursive: true });
      await state.writeConfig({
        agents: { defaults: { workspace: state.workspaceDir } },
        cron: { enabled: true },
        gateway: {
          auth: { mode: "none" },
          controlUi: {
            allowedOrigins: [new URL(suite.server.baseUrl).origin],
            enabled: false,
          },
          port,
        },
      });
      state.applyEnv();
      const { startGatewayServer } = await import("../../../src/gateway/server.js");
      gateway = await startGatewayServer(port, {
        auth: { mode: "none" },
        bind: "loopback",
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });

      await suite.withPage(
        {
          locale: "en-US",
          serviceWorkers: "block",
          viewport: { height: 900, width: 1_440 },
        },
        async ({ page }) => {
          const url = new URL("cron", suite.server.baseUrl);
          url.searchParams.set("gatewayUrl", `ws://127.0.0.1:${port}`);
          await page.goto(url.toString());
          const confirmation = page.locator("openclaw-gateway-url-confirmation");
          await confirmation.waitFor();
          await confirmation.getByRole("button", { name: "Confirm", exact: true }).click();
          await waitForControlUiGatewayReady(page, { timeout: 30_000 });

          const createJob = async (name: string, group: string, tags: string) => {
            await page.locator('[data-test-id="cron-new-task"]').click({ force: true });
            const nameInput = page.locator("#cron-name");
            await nameInput.waitFor({ state: "visible", timeout: 30_000 });
            await expect.poll(() => nameInput.isEditable(), { timeout: 60_000 }).toBe(true);
            await nameInput.fill(name);
            await page.locator("#cron-group").fill(group);
            await page.locator("#cron-tags").fill(tags);
            await page.locator("#cron-payload-text").fill(`${name} fired`);
            await page.locator("wa-select#cron-payload-kind").click({ force: true });
            await page.getByRole("option", { name: "Post to main timeline", exact: true }).click();
            await page.locator('[data-test-id="cron-submit"]').click();
            await page
              .locator(".cron-table__name-text", { hasText: new RegExp(`^${name}$`, "u") })
              .waitFor();
          };

          await createJob("Real Gateway Work", "Work", "sales\\,emea, daily");
          await createJob("Real Gateway Personal", "Personal", "home");

          const groupFilter = page.locator('[data-test-id="cron-jobs-group-filter"]');
          await page.locator(".cron-filter-popover__trigger").click();
          await groupFilter.fill("Work");
          await expect
            .poll(() => page.locator(".cron-table__name-text").allTextContents())
            .toEqual(["Real Gateway Work"]);
          await expect
            .poll(() => page.locator(".cron-table__tag").allTextContents())
            .toEqual(["sales,emea", "daily"]);

          await page.screenshot({
            path: path.join(suite.artifactDir, "automation-grouping-real-gateway.png"),
            fullPage: true,
          });

          await page.locator(".cron-table__name-text", { hasText: /^Real Gateway Work$/u }).click();
          await expect
            .poll(() => page.locator("#cron-tags").inputValue())
            .toBe("sales\\,emea, daily");
          await page.locator("#cron-group").fill("");
          await page.locator("#cron-tags").fill("");
          await page.locator('[data-test-id="cron-submit"]').click();

          await expect
            .poll(() => page.locator(".cron-table__name-text").allTextContents())
            .toEqual([]);
          const persisted = (await loadCronStore(state.path("cron", "jobs.json"))).jobs.find(
            (job) => job.name === "Real Gateway Work",
          );
          expect(persisted).toBeDefined();
          expect(persisted).toHaveProperty("name", "Real Gateway Work");
          expect(persisted).not.toHaveProperty("group");
          expect(persisted).not.toHaveProperty("tags");
          console.log(
            JSON.stringify({
              observed: [
                "Control UI created two automations through a real Gateway",
                "group=Work reached the real cron.list handler and hid the Personal row",
                "comma-bearing tags round-tripped through the form and rendered literally",
                "clearing group and tags removed both fields from the persisted cron store",
              ],
              screenshot: path.join(suite.artifactDir, "automation-grouping-real-gateway.png"),
            }),
          );
        },
      );
    } finally {
      try {
        await gateway?.close({ reason: "cron grouping real Gateway e2e cleanup" });
      } finally {
        await state.cleanup();
      }
    }
  });
});

import { expect, it } from "vitest";
import { CONTROL_UI_BOOTSTRAP_CONFIG_PATH } from "../../../src/gateway/control-ui-bootstrap-contract.js";
import {
  createControlUiMockBootstrapConfig,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI shell avatar initials",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it.each([
    { name: "😀Alice", environment: true, initial: "😀" },
    { name: "alice", environment: true, initial: "a" },
    { name: "😀Alice", environment: false, initial: null },
  ])("preserves $name with environment=$environment", async ({ name, environment, initial }) => {
    await suite.withPage({ viewport: { width: 1440, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, { assistantName: name });
      await page.route(`**${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`, (route) =>
        route.fulfill({
          json: {
            ...createControlUiMockBootstrapConfig({ assistantName: name }),
            ...(environment ? { environment: { label: "edge", color: "amber" } } : {}),
          },
        }),
      );
      const bootstrap = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === CONTROL_UI_BOOTSTRAP_CONFIG_PATH &&
          response.request().method() === "GET",
      );
      const [, response] = await Promise.all([
        page.goto(`${suite.server.baseUrl}dashboards`),
        bootstrap,
      ]);
      expect(response.status()).toBe(200);
      await page.locator(".sidebar-brand__collapse").click();
      const toggle = page.locator(".shell-chrome-controls__nav-toggle");
      await toggle.waitFor();
      if (environment) {
        await page.locator(".shell-chrome-controls__nav-toggle[data-env-avatar]").waitFor();
      }
      expect(await toggle.getAttribute("data-env-avatar")).toBe(initial);
      if (initial) {
        expect(
          await toggle.evaluate((element) => getComputedStyle(element, "::before").content),
        ).toContain(initial);
      }
      await toggle.click();
      await page.locator(".sidebar-brand__collapse").waitFor();
      await expect.poll(() => toggle.count()).toBe(0);
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
    });
  });
});

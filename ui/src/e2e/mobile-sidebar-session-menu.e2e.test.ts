import { expect, it } from "vitest";
import { captureControlUiE2eFailureDiagnostics } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite(true);

suite.define(() => {
  it("keeps mobile sidebar session menu groups inside the viewport", async () => {
    const sessionKey = "agent:main:mobile-sidebar-menu";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      hasTouch: true,
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 650, width: 390 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(sessionKey, "Mobile sidebar menu", Date.parse("2026-08-19T03:00:00.000Z"), {
            category: "Research",
          }),
        ]),
      },
      sessionGroups: [
        "Research",
        "Operations",
        "Planning",
        ...Array.from({ length: 24 }, (_, index) => `Team ${index + 1}`),
      ],
      sessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
      const drawerToggle = page
        .locator(".topbar-nav-toggle:visible, .chat-pane__nav-toggle:visible")
        .first();
      await drawerToggle.waitFor({ state: "visible", timeout: 10_000 });
      await drawerToggle.click();

      const row = page.locator(`[data-session-key="${sessionKey}"]`);
      await row.waitFor({ state: "visible" });
      await row.getByRole("button", { name: "Open session menu" }).click();

      const menu = page.getByRole("menu", { name: "Actions for Mobile sidebar menu" });
      await menu.waitFor({ state: "visible" });
      await captureUiProof(suite, page, "mobile-sidebar-session-menu-after-root.png");

      expect(await page.locator("openclaw-session-menu [slot='submenu']").count()).toBe(0);
      await page.getByRole("menuitem", { name: "Move to group" }).click();
      const back = page.getByRole("menuitem", { name: "Back" });
      await back.waitFor({ state: "visible" });
      await page.getByRole("menuitemradio", { name: "Operations" }).waitFor({ state: "visible" });
      expect(await page.locator("openclaw-session-menu [slot='submenu']").count()).toBe(0);
      const menuBox = await menu.boundingBox();
      if (!menuBox) {
        throw new Error("expected visible compact sidebar session menu");
      }
      expect(menuBox.x).toBeGreaterThanOrEqual(8);
      expect(menuBox.x + menuBox.width).toBeLessThanOrEqual(382);
      expect(menuBox.y).toBeGreaterThanOrEqual(8);
      expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(642);
      const scroll = await menu.evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return {
          clientHeight: element.clientHeight,
          scrollHeight: element.scrollHeight,
          scrollTop: element.scrollTop,
        };
      });
      expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
      expect(scroll.scrollTop).toBeGreaterThan(0);
      const backBox = await back.boundingBox();
      if (!backBox) {
        throw new Error("expected sticky Back action bounds");
      }
      expect(backBox.y).toBeGreaterThanOrEqual(menuBox.y);
      expect(backBox.y + backBox.height).toBeLessThanOrEqual(menuBox.y + menuBox.height);
      await captureUiProof(suite, page, "mobile-sidebar-session-menu-after-group-drilldown.png");
    } catch (error) {
      await captureControlUiE2eFailureDiagnostics(page, {
        error: error instanceof Error ? error : new Error(String(error)),
        label: "mobile-sidebar-session-menu",
      });
      throw error;
    } finally {
      await context.close();
    }
  });
});

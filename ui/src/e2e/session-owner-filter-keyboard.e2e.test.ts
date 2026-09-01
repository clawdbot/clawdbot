import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("navigates the owner filter submenu with arrow, Enter, and Escape keys", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 800, width: 1200 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: "agent:main:ada",
      presenceUsers: [{ self: true, id: "profile-patrick", name: "Patrick" }],
      historyMessages: [{ role: "assistant", content: [{ type: "text", text: "Ready." }] }],
      methodResponses: {
        "sessions.list": {
          ...sessionsListResponse([
            sessionRow("agent:main:ada", "Ada research", 2),
            sessionRow("agent:main:bob", "Bob operations", 1),
          ]),
          owners: [
            { type: "human", id: "profile-ada", label: "Ada" },
            { type: "human", id: "profile-bob", label: "Bob" },
          ],
        },
      },
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:ada"));
      const trigger = page.getByRole("button", { name: "Filter & sort" });
      await trigger.focus();
      await page.keyboard.press("Enter");
      const menu = page.locator(".sidebar-session-sort-menu");
      const ownerSubmenu = menu.getByRole("menuitem", { name: "Owners", exact: true });
      const focusedTopLevelItem = menu.locator(
        ':scope > wa-dropdown-item:not([slot="submenu"]):focus',
      );
      await expect.poll(() => focusedTopLevelItem.count()).toBe(1);
      const parentIndex = await ownerSubmenu.evaluate((element) =>
        [...(element.parentElement?.children ?? [])]
          .filter(
            (item) =>
              item.localName === "wa-dropdown-item" && item.getAttribute("slot") !== "submenu",
          )
          .indexOf(element),
      );
      expect(parentIndex).toBeGreaterThanOrEqual(0);

      const focusOwnerSubmenu = async () => {
        await page.keyboard.press("Home");
        for (let step = 0; step < parentIndex; step += 1) {
          await page.keyboard.press("ArrowDown");
        }
      };
      await focusOwnerSubmenu();
      await expect
        .poll(() => ownerSubmenu.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.keyboard.press("ArrowRight");
      await expect.poll(() => ownerSubmenu.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("Escape");
      await expect.poll(() => ownerSubmenu.getAttribute("aria-expanded")).toBe("false");
      await expect.poll(() => menu.getAttribute("open")).toBeNull();
      await expect
        .poll(() => trigger.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.keyboard.press("Enter");
      await expect.poll(() => focusedTopLevelItem.count()).toBe(1);
      await focusOwnerSubmenu();
      await page.keyboard.press("ArrowRight");
      await expect.poll(() => ownerSubmenu.getAttribute("aria-expanded")).toBe("true");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Enter");
      await expect
        .poll(async () =>
          (await gateway.getRequests("sessions.list")).some(
            (request) =>
              (request.params as { ownerId?: unknown } | undefined)?.ownerId === "profile-ada",
          ),
        )
        .toBe(true);
      await expect.poll(() => menu.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

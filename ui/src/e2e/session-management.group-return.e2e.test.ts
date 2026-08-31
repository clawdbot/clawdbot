import type { Page } from "playwright";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  requireRecord,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

async function setThemeMode(page: Page, mode: "dark" | "light"): Promise<void> {
  await page.emulateMedia({ colorScheme: mode });
  await page.evaluate((nextMode) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextMode;
    root.dataset.themeResolved = nextMode;
    root.classList.toggle("wa-light", nextMode === "light");
    root.classList.toggle("wa-dark", nextMode === "dark");
    root.style.colorScheme = nextMode;
  }, mode);
  await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe(mode);
}

suite.define(() => {
  it("moves a categorized group session back to Groups", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await suite.browser.newContext({
      colorScheme: "light",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", baseTime),
          {
            ...sessionRow("agent:main:done-group", "Completed launch", baseTime - 60_000, {
              category: "Done",
            }),
            kind: "group",
          },
        ]),
        "sessions.patch": {},
      },
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.put",
        "sessions.patch",
      ],
      sessionGroups: ["Done"],
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const done = page.locator('[data-session-section="category:Done"]');
      const groups = page.locator('[data-session-section="groups"]');
      const row = done.locator('[data-session-key="agent:main:done-group"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await groups.waitFor({ state: "visible" });

      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await openSessionMenuSubmenu(page, "Move to group");
      await page.getByRole("menuitem", { name: "Move back to Groups" }).waitFor({
        state: "visible",
      });
      await setThemeMode(page, "light");
      await captureUiProof(page, "sidebar-done-return-before-light.png");
      await setThemeMode(page, "dark");
      await captureUiProof(page, "sidebar-done-return-before-dark.png");

      await setThemeMode(page, "light");
      await page.reload();
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await groups.waitFor({ state: "visible" });
      await expect.poll(() => row.getAttribute("draggable")).toBe("true");
      await row.dragTo(groups, {
        sourcePosition: { x: 8, y: 8 },
        targetPosition: { x: 8, y: 8 },
      });
      const patch = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:done-group" && params.category === null,
      );
      expect(requireRecord(patch.params)).toMatchObject({
        category: null,
        key: "agent:main:done-group",
      });
      await groups.locator('[data-session-key="agent:main:done-group"]').waitFor({
        state: "visible",
      });
      await captureUiProof(page, "sidebar-done-return-after-light.png");
      await setThemeMode(page, "dark");
      await captureUiProof(page, "sidebar-done-return-after-dark.png");
    } finally {
      await context.close();
    }
  });
});

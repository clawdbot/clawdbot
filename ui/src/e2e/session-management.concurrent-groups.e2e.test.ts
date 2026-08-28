import { expect, it } from "vitest";
import {
  activateSelfRemovingControl,
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  sessionRow,
  sessionsListResponse,
  submitInputDialog,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("shares concurrent group additions across tabs without losing either name", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });

    async function openTab(sessionKey: string, label: string) {
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "sessions.groups.add",
          "sessions.groups.list",
          "sessions.groups.put",
          "sessions.patch",
        ],
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(sessionKey, label, Date.parse("2026-08-27T12:00:00.000Z")),
          ]),
          "sessions.patch": {},
        },
        sessionKey,
        sessionGroups: [],
        shareSessionGroupsAcrossTabs: true,
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      return { page, gateway };
    }

    async function createGroupFromSessionMenu(page: typeof tab1.page, name: string) {
      const row = page.locator(".sidebar-recent-session").first();
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await openSessionMenuSubmenu(page, "Move to group");
      const newGroupItem = page.getByRole("menuitem", { name: "New group…" });
      await newGroupItem.waitFor({ state: "visible" });
      await activateSelfRemovingControl(newGroupItem);
      await submitInputDialog(page, name);
      await page.locator(`[data-session-section="category:${name}"]`).waitFor({ state: "visible" });
    }

    const tab1 = await openTab("agent:main:tab-one", "Tab one session");
    const tab2 = await openTab("agent:main:tab-two", "Tab two session");

    try {
      await createGroupFromSessionMenu(tab1.page, "Alpha");
      await captureUiProof(tab1.page, "concurrent-groups-tab1-alpha.png");

      await createGroupFromSessionMenu(tab2.page, "Beta");
      await captureUiProof(tab2.page, "concurrent-groups-tab2-beta.png");

      // Each tab must eventually observe the group created in the other tab.
      await tab1.page.locator('[data-session-section="category:Beta"]').waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await tab2.page.locator('[data-session-section="category:Alpha"]').waitFor({
        state: "visible",
        timeout: 10_000,
      });

      const sectionIds = async (page: typeof tab1.page) =>
        page
          .locator('[data-session-section^="category:"]')
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-session-section")),
          );

      await expect.poll(() => sectionIds(tab1.page)).toEqual(["category:Alpha", "category:Beta"]);
      await expect.poll(() => sectionIds(tab2.page)).toEqual(["category:Alpha", "category:Beta"]);

      await captureUiProof(tab1.page, "concurrent-groups-tab1-both.png");
      await captureUiProof(tab2.page, "concurrent-groups-tab2-both.png");

      // Each tab issued exactly one atomic add for its own group.
      expect(await tab1.gateway.getRequests("sessions.groups.add")).toHaveLength(1);
      expect(await tab2.gateway.getRequests("sessions.groups.add")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});

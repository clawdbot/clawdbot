import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
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

    async function openNewGroupDialog(page: typeof tab1.page) {
      const row = page.locator(".sidebar-recent-session").first();
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await openSessionMenuSubmenu(page, "Move to group");
      const newGroupItem = page.getByRole("menuitem", { name: "New group" });
      await newGroupItem.waitFor({ state: "visible" });
      await activateSelfRemovingControl(newGroupItem);
      // Keep the dialog open: both callers must submit from the same
      // pre-mutation catalog to exercise the reported stale-catalog race.
      await page.locator("openclaw-modal-dialog input").waitFor({ state: "visible" });
    }

    async function submitNewGroupDialog(page: typeof tab1.page, name: string) {
      // The deferred Gateway response keeps the dialog open, so the stale
      // submission must not wait for the dialog to close.
      await submitInputDialog(page, name, { waitForClose: false });
    }

    const tab1 = await openTab("agent:main:tab-one", "Tab one session");
    const tab2 = await openTab("agent:main:tab-two", "Tab two session");

    try {
      // Hold both callers at the same empty catalog before either mutates.
      // The old read-modify-write replacement lost one name here; the atomic
      // add must keep both. Deferring both add responses keeps the mock from
      // persisting or broadcasting either group until both stale submissions
      // are in flight, so the regression fails on lost data rather than on
      // which RPC the UI selected.
      await openNewGroupDialog(tab1.page);
      await openNewGroupDialog(tab2.page);

      await tab1.gateway.deferNext("sessions.groups.add");
      await tab2.gateway.deferNext("sessions.groups.add");

      await submitNewGroupDialog(tab1.page, "Alpha");
      await submitNewGroupDialog(tab2.page, "Beta");

      // The submissions are async after Enter; only release once both stale
      // requests have reached the mock.
      await tab1.gateway.waitForRequest("sessions.groups.add");
      await tab2.gateway.waitForRequest("sessions.groups.add");
      await tab1.gateway.resolveDeferred("sessions.groups.add");
      await tab2.gateway.resolveDeferred("sessions.groups.add");

      await tab1.page.locator('[data-session-section="category:Alpha"]').waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await captureUiProof(suite, tab1.page, "concurrent-groups-tab1-alpha.png");
      await tab2.page.locator('[data-session-section="category:Beta"]').waitFor({
        state: "visible",
        timeout: 10_000,
      });
      await captureUiProof(suite, tab2.page, "concurrent-groups-tab2-beta.png");

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

      await captureUiProof(suite, tab1.page, "concurrent-groups-tab1-both.png");
      await captureUiProof(suite, tab2.page, "concurrent-groups-tab2-both.png");

      // Each tab issued exactly one atomic add for its own group.
      expect(await tab1.gateway.getRequests("sessions.groups.add")).toHaveLength(1);
      expect(await tab2.gateway.getRequests("sessions.groups.add")).toHaveLength(1);
    } finally {
      await context.close();
    }
  });
});

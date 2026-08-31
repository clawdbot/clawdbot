import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  openSessionMenuSubmenu,
  requireRecord,
  sessionsListResponse,
  submitInputDialog,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("names a new group in the owned dialog instead of a browser prompt", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const nativeDialogs: string[] = [];
    page.on("dialog", (dialog) => {
      nativeDialogs.push(dialog.type());
      void dialog.dismiss();
    });
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.put",
        "sessions.patch",
      ],
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:move-me", "Move me", Date.parse("2026-07-01T16:00:00.000Z")),
        ]),
      },
      sessionKey: "agent:main:move-me",
    });

    async function openNewGroupDialog() {
      const row = page.locator('.sidebar-recent-session[data-session-key="agent:main:move-me"]');
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await openSessionMenuSubmenu(page, "Move to group");
      await activateSelfRemovingControl(page.getByRole("menuitem", { name: "New group…" }));
      const field = page.getByLabel("New group name");
      await field.waitFor({ state: "visible" });
      return field;
    }

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:move-me"));
      const field = await openNewGroupDialog();
      const create = page.getByRole("button", { name: "Create group" });
      await captureUiProof(suite, page, "new-group-dialog-dark.png");

      // Opening the dialog writes nothing, hands focus to the field, and holds
      // the create action closed until a non-blank name exists.
      expect(await gateway.getRequests("sessions.groups.put")).toHaveLength(0);
      await expect
        .poll(() => field.evaluate((element) => element === document.activeElement))
        .toBe(true);
      expect(await create.isDisabled()).toBe(true);
      await field.fill("   ");
      expect(await create.isDisabled()).toBe(true);

      await page.emulateMedia({ colorScheme: "light" });
      await captureUiProof(suite, page, "new-group-dialog-light.png");
      await page.emulateMedia({ colorScheme: "dark" });

      // Compact viewports keep the whole dialog on screen.
      await page.setViewportSize({ height: 720, width: 420 });
      const card = page.locator("openclaw-modal-dialog .exec-approval-card");
      const bounds = await card.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(420);
      await captureUiProof(suite, page, "new-group-dialog-compact.png");
      await page.setViewportSize({ height: 900, width: 1280 });

      // Escape leaves the session untouched.
      await page.keyboard.press("Escape");
      await field.waitFor({ state: "detached" });
      expect(await gateway.getRequests("sessions.groups.put")).toHaveLength(0);
      expect(await gateway.getRequests("sessions.patch")).toHaveLength(0);

      await openNewGroupDialog();
      await submitInputDialog(page, "  Client work  ");

      await page
        .locator('[data-session-section="category:Client work"]')
        .waitFor({ state: "visible" });
      const putRequest = await gateway.waitForRequest("sessions.groups.put");
      expect(requireRecord(putRequest.params)).toMatchObject({ names: ["Client work"] });
      const patched = await waitForPatch(
        gateway,
        (params) => params.key === "agent:main:move-me" && params.category === "Client work",
      );
      expect(requireRecord(patched.params)).toMatchObject({ category: "Client work" });
      const categoryPatches = (await gateway.getRequests("sessions.patch")).filter(
        (request) => requireRecord(request.params).category === "Client work",
      );
      expect(categoryPatches).toHaveLength(1);
      expect(nativeDialogs).toEqual([]);
      await captureUiProof(suite, page, "new-group-created.png");
    } finally {
      await context.close();
    }
  });
});

import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  createSessionManagementE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  openSessionMenuSubmenu,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();
const activeSessionKey = "agent:main:active-proof";
const sessionKey = "agent:main:copy-id-proof";
const sessionId = "93be7617-9d1e-4091-aa0f-33332aff3321";

suite.define(() => {
  it("copies the session ID from the session menu", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    await context.grantPermissions(["clipboard-read", "clipboard-write"], {
      origin: new URL(suite.server.baseUrl).origin,
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup"],
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(
            activeSessionKey,
            "Active proof session",
            Date.parse("2026-08-15T06:01:00.000Z"),
          ),
          sessionRow(sessionKey, "Copy session ID proof", Date.parse("2026-08-15T06:00:00.000Z"), {
            sessionId,
          }),
        ]),
      },
      sessionKey: activeSessionKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, activeSessionKey));
      const row = page.locator(`.sidebar-recent-session[data-session-key="${sessionKey}"]`);
      await expect.poll(() => row.count()).toBe(1);
      await row.hover();
      await row.getByRole("button", { name: "Open session menu: Copy session ID proof" }).click();

      const menuHost = page.locator("openclaw-session-menu");
      await openSessionMenuSubmenu(page, "Copy");
      const copyItem = menuHost.getByRole("menuitem", { name: "Session ID", exact: true });
      await expect.poll(() => copyItem.count()).toBe(1);
      await captureUiProof(page, "copy-session-id-menu.png");

      await activateSelfRemovingControl(copyItem);

      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(sessionId);
      await expect.poll(() => page.locator(".app-toast").textContent()).toContain("Copied");
    } finally {
      await context.close();
    }
  });
});

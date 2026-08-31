import { expect, it } from "vitest";
import type { ChatPaneElement } from "../pages/chat/route-draft-focus-handoff.ts";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";
import { waitForSettledFormControls } from "./settle.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps the browser-local draft pencil visible on active Home beside activity", async () => {
    const mainKey = "agent:main:main";
    const secondKey = "agent:main:draft-second";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(mainKey, "Main", 2, {
            hasActiveRun: true,
            startedAt: 1,
            status: "running",
          }),
          sessionRow(secondKey, "Draft second", 1),
        ]),
      },
      sessionKey: mainKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainKey));
      const homeRow = page.locator(".nav-item--home");
      const secondRow = page.locator(`[data-session-key="${secondKey}"]`);
      const composer = page.locator(
        'openclaw-chat-pane[aria-hidden="false"] .agent-chat__composer-combobox > textarea',
      );
      await homeRow.waitFor({ state: "visible", timeout: 10_000 });
      await secondRow.waitFor({ state: "visible" });
      await composer.waitFor({ state: "visible" });
      await captureUiProof(page, "draft-indicator-before.png");

      await composer.fill("Keep this unsent");
      const activity = homeRow.getByRole("img", { name: "Active run" });
      const draft = homeRow.getByRole("img", { name: "Unsent draft" });
      await activity.waitFor();
      await draft.waitFor();
      const activityBox = await activity.boundingBox();
      const draftBox = await draft.boundingBox();
      if (!activityBox || !draftBox) {
        throw new Error("expected activity and draft icon bounds");
      }
      expect(draftBox.x).toBeGreaterThanOrEqual(activityBox.x + activityBox.width);
      await captureUiProof(page, "draft-indicator-active.png");

      await secondRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(secondKey));
      await draft.waitFor();

      await homeRow.click();
      await waitForControlUiRoute(page, {
        pathname: controlUiSessionPath(mainKey),
        routeId: "chat",
      });
      await draft.waitFor();
      const presentedPanes = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      await expect
        .poll(() =>
          presentedPanes.evaluateAll((panes) =>
            panes.map((pane) => (pane as ChatPaneElement).sessionKey),
          ),
        )
        .toEqual([mainKey]);

      await waitForSettledFormControls(page, [{ locator: composer, value: "Keep this unsent" }]);
      await composer.fill("");
      await waitForSettledFormControls(page, [{ locator: composer, value: "" }]);
      await expect.poll(() => draft.count()).toBe(0);
      await secondRow.getByRole("link").click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(secondKey));
      await expect.poll(() => draft.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});

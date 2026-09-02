import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("keeps a saved permission mode when its list refresh fails", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const session = {
      key: "agent:main:permission-refresh",
      kind: "direct",
      label: "Permission refresh",
      permissionMode: "guarded",
      sessionId: "permission-refresh-generation",
      updatedAt: 1,
    };
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": chatSessionListResponse([session]) },
      sessionKey: session.key,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const trigger = pane.locator('[data-chat-permission-select="true"]');
      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("guarded");
      const listRequests = (await gateway.getRequests("sessions.list")).length;
      await gateway.deferNext("sessions.list");

      await trigger.click();
      await pane.locator('[data-chat-permission-option="workspace"]').click();
      await gateway.waitForRequest("sessions.patch");
      await gateway.waitForRequest("sessions.list", { after: listRequests });
      await gateway.rejectDeferred("sessions.list", {
        code: "UNAVAILABLE",
        message: "Roster refresh unavailable",
      });

      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("workspace");
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      await pane
        .locator(".chat-error")
        .getByText("Permissions were saved", { exact: false })
        .waitFor();
      await pane
        .locator(".chat-error")
        .getByText("Roster refresh unavailable", { exact: false })
        .waitFor();
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});

import { expect, it } from "vitest";
import type { ApplicationContext } from "../app/context.ts";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";

const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };
type PermissionTestApp = HTMLElement & { runtime?: { context: ApplicationContext } };

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
      const listRequests = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await gateway.deferNext("sessions.list", rosterMatch);

      await trigger.click();
      await pane.locator('[data-chat-permission-option="workspace"]').click();
      await gateway.waitForRequest("sessions.patch");
      await gateway.waitForRequest("sessions.list", { after: listRequests, match: rosterMatch });
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

  it("keeps a newer permission event after an older patch response arrives", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const session = {
      key: "agent:main:permission-ordering",
      kind: "direct",
      label: "Permission ordering",
      permissionMode: "guarded",
      sessionId: "permission-ordering-generation",
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
      const listRequests = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await gateway.deferNext("sessions.patch", { permissionMode: "workspace" });

      await trigger.click();
      await pane.locator('[data-chat-permission-option="workspace"]').click();
      await gateway.waitForRequest("sessions.patch");
      await gateway.deferNext("sessions.list", rosterMatch);
      await gateway.emitGatewayEvent("sessions.changed", {
        ...session,
        sessionKey: session.key,
        reason: "patch",
        permissionMode: "full",
        updatedAt: 3,
      });
      await expect
        .poll(() =>
          page.evaluate((key) => {
            const app = document.querySelector("openclaw-app") as PermissionTestApp;
            return app.runtime?.context.sessions.state.result?.sessions.find(
              (row) => row.key === key,
            )?.permissionMode;
          }, session.key),
        )
        .toBe("full");
      await gateway.waitForRequest("sessions.list", { after: listRequests, match: rosterMatch });
      await gateway.resolveDeferred("sessions.patch", {
        key: session.key,
        entry: {
          permissionMode: "workspace",
          sessionId: session.sessionId,
          updatedAt: 2,
        },
      });

      await expect.poll(() => trigger.getAttribute("data-chat-select-value")).toBe("full");
      await expect.poll(() => trigger.isEnabled()).toBe(true);
      expect(await gateway.getRequests("sessions.list", rosterMatch)).toHaveLength(
        listRequests + 1,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});

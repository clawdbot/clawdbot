import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  installMockGateway,
  startControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eSuite,
  holdModuleResponse,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI approval bootstrap",
  startServer: () => startControlUiE2eServer(undefined, { source: true }),
});

suite.define(() => {
  it("keeps an approval received before the initial pending-list refresh", async () => {
    await suite.withPage({ viewport: { height: 800, width: 1200 } }, async ({ page }) => {
      const sessionKey = "agent:main:main";
      const gateway = await installMockGateway(page, { sessionKey });
      const bootstrap = await holdModuleResponse(page, /connection-bootstrap\.runtime/);
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey));
        await bootstrap.request;
        await gateway.waitForRequest("sessions.list");
        await gateway.emitGatewayEvent("exec.approval.requested", {
          id: "approval-before-refresh",
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + 60_000,
          request: { command: "echo pending", agentId: "main", sessionKey },
        });
        const inlineCard = page.locator(
          '.chat-inline-approval [data-approval-id="approval-before-refresh"]',
        );
        await inlineCard.waitFor();
        bootstrap.release();
        await gateway.waitForRequest("exec.approval.list");
        await page.locator("openclaw-sidebar-attention .sidebar-issues-button").click();
        await page
          .locator(
            'openclaw-sidebar-attention #sidebar-issues-panel [data-approval-id="approval-before-refresh"]',
          )
          .waitFor();
        expect(await inlineCard.count()).toBe(1);
      } finally {
        bootstrap.release();
      }
    });
  });
});

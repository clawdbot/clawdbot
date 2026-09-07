import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps the page Refresh control stable during background roster reads", async () => {
    const key = "agent:main:background-refresh";
    const row = sessionRow(key, "Background refresh", 1);
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": sessionsListResponse([row]) },
      sessionKey: key,
    });
    let heldRequest = false;
    try {
      await page.goto(`${suite.server.baseUrl}sessions`);
      const refresh = page.locator(".settings-section__actions .btn").last();
      await expect.poll(async () => (await refresh.textContent())?.trim()).toBe("Refresh");
      await gateway.waitForRequest("sessions.subscribe");
      await page.waitForTimeout(1_200);

      const pageQuery = { includeUnknown: false };
      await gateway.deferNext("sessions.list", pageQuery);
      const before = (await gateway.getRequests("sessions.list", pageQuery)).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: key,
        reason: "update",
        updatedAt: 2,
      });
      await gateway.waitForRequest("sessions.list", { after: before, match: pageQuery });
      heldRequest = true;
      await page.waitForTimeout(50);
      await captureUiProof(suite, page, "sessions-background-refresh.png");

      expect((await refresh.textContent())?.trim()).toBe("Refresh");
      expect(await refresh.isEnabled()).toBe(true);
    } finally {
      if (heldRequest) {
        await gateway.resolveDeferred("sessions.list");
      }
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps the selected roster quiet during other agents' activity and refreshes its own changes", async () => {
    const key = "agent:main:weekly-report";
    const row = sessionRow(key, "Weekly report", 1);
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      ...(captureUiProofEnabled
        ? { recordVideo: { dir: suite.artifactDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const video = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: { "sessions.list": sessionsListResponse([row]) },
      sessionKey: key,
    });
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      const sidebar = page.locator("openclaw-app-sidebar");
      const selectedRow = sidebar.locator(`[data-session-key="${key}"]`);
      await expect.poll(() => selectedRow.textContent()).toContain("Weekly report");
      await gateway.waitForRequest("sessions.subscribe");
      // Let startup settle before counting event-driven network traffic.
      await page.waitForTimeout(1_200);
      const before = (await gateway.getRequests("sessions.list")).length;
      await captureUiProof(suite, page, "roster-before-other-agent-events.png");
      for (let burst = 0; burst < 3; burst += 1) {
        for (let index = 0; index < 20; index += 1) {
          await gateway.emitGatewayEvent("sessions.changed", {
            sessionKey: `agent:research:task-${index}`,
            reason: "update",
            updatedAt: burst + 2,
          });
        }
        // Each burst crosses the real debounce window; sustained traffic must
        // not make an unrelated selected roster poll once per burst.
        await page.waitForTimeout(300);
      }
      await captureUiProof(suite, page, "roster-after-other-agent-events.png");
      expect((await gateway.getRequests("sessions.list")).length - before).toBe(0);
      expect(await selectedRow.textContent()).toContain("Weekly report");

      await gateway.setSessionsListResponse(
        sessionsListResponse([{ ...row, label: "Weekly report ready", updatedAt: 5 }]),
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        sessionKey: key,
        reason: "update",
        updatedAt: 5,
      });
      await expect.poll(() => selectedRow.textContent()).toContain("Weekly report ready");
      expect((await gateway.getRequests("sessions.list")).length - before).toBe(1);
      await captureUiProof(suite, page, "roster-own-agent-updated.png");
    } finally {
      await suite.closeBrowserContext(context);
      if (video) {
        await video.saveAs(path.join(suite.artifactDir, "roster-event-scope.webm"));
      }
    }
  });
});

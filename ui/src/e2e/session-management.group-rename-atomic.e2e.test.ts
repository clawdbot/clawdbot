import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  activateSelfRemovingControl,
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
  submitInputDialog,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("renames a populated group as one visible transition", async () => {
    const baseTime = Date.parse("2026-07-01T16:00:00.000Z");
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: suite.artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      featureMethods: [
        "chat.metadata",
        "chat.startup",
        "sessions.groups.list",
        "sessions.groups.rename",
      ],
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:paper", "Paper", baseTime, { category: "Research" }),
        ]),
      },
      sessionGroups: ["Research"],
      sessionKey: "agent:main:paper",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:paper"));
      const research = page.locator('[data-session-section="category:Research"]');
      await research.waitFor({ state: "visible", timeout: 10_000 });
      await expect.poll(() => research.locator(".sidebar-recent-session").count()).toBe(1);

      const listRequestsBeforeRename = (await gateway.getRequests("sessions.list")).length;
      await gateway.deferNext("sessions.list");
      await research.locator(".sidebar-recent-sessions__head").hover();
      await research.getByRole("button", { name: "Group options for Research" }).click();
      await activateSelfRemovingControl(page.getByRole("menuitem", { name: "Rename group…" }));
      await submitInputDialog(page, "Projects");
      await gateway.waitForRequest("sessions.groups.rename");
      await gateway.waitForRequest("sessions.list", { after: listRequestsBeforeRename });

      if (captureUiProofEnabled) {
        await captureUiProof(suite, page, "group-rename-pending-refresh.png");
        await page.waitForTimeout(1_500);
      }
      expect(
        await page
          .locator('[data-session-section^="category:"]')
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-session-section")),
          ),
      ).toEqual(["category:Projects"]);
      const projects = page.locator('[data-session-section="category:Projects"]');
      await expect.poll(() => projects.locator(".sidebar-recent-session").count()).toBe(1);

      await gateway.resolveDeferred("sessions.list");
      await expect.poll(() => projects.locator(".sidebar-recent-session").count()).toBe(1);
    } finally {
      await context.close();
      if (captureUiProofEnabled && proofVideo) {
        await proofVideo.saveAs(path.join(suite.artifactDir, "group-rename-atomic.webm"));
      }
    }
  });
});

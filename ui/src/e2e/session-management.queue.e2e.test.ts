import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
  uiProofArtifactDir,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("removes the concurrency subtitle while preserving queued state", async () => {
    const mainKey = "agent:main:main";
    const queuedKey = "agent:main:queued-repair";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(mainKey, "Main", 2),
          sessionRow(queuedKey, "Queued repair", 1, {
            hasActiveRun: true,
            status: "queued",
          }),
        ]),
      },
      sessionKey: mainKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, mainKey));
      const row = page.locator(`[data-session-key="${queuedKey}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      expect(await row.getByText("Waiting for a concurrency slot", { exact: true }).count()).toBe(
        0,
      );
      expect(await row.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
      const queuedIcon = row.locator(".sidebar-child-session__status--queued");
      await queuedIcon.waitFor();
      expect(await queuedIcon.getAttribute("aria-label")).toBe("Queued");
      expect(await row.getByRole("img", { name: "Active run" }).count()).toBe(0);
      await captureUiProof(page, "queued-session-without-subtitle.png");

      const listRequests = (await gateway.getRequests("sessions.list")).length;
      await gateway.setMethodResponse(
        "sessions.list",
        sessionsListResponse([
          sessionRow(mainKey, "Main", 2),
          sessionRow(queuedKey, "Queued repair", 1, {
            hasActiveRun: true,
            status: "running",
          }),
        ]),
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        hasActiveRun: true,
        key: queuedKey,
        reason: "agent.run.started",
        status: "running",
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(listRequests);
      await row.locator(".session-run-spinner").waitFor();
      expect(await row.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
      expect(await queuedIcon.count()).toBe(0);
      await captureUiProof(page, "queued-session-running.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(uiProofArtifactDir, "queued-session.webm"));
      }
    }
  });
});

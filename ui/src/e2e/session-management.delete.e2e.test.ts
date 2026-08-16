import path from "node:path";
import { expect, it } from "vitest";
import { expectRequestCountStable } from "./chat-flow.test-support.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
  uiProofArtifactDir,
  waitForConfirmModal,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("rejects deleting a same-key replacement after the in-app confirm", async () => {
    const key = "agent:main:research";
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
      recordVideo: captureUiProofEnabled
        ? { dir: uiProofArtifactDir, size: { height: 900, width: 1280 } }
        : undefined,
    });
    const page = await context.newPage();
    const proofVideo = page.video();
    // Playwright auto-dismisses native dialogs, which is exactly how a
    // bridge-less WebView behaves. Deleting must not depend on one.
    const nativeDialogs: string[] = [];
    page.on("dialog", (dialog) => {
      nativeDialogs.push(dialog.message());
      void dialog.dismiss();
    });
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.delete": { ok: true, deleted: true },
        "sessions.list": sessionsListResponse([
          sessionRow("agent:main:main", "Main", Date.parse("2026-07-01T16:00:00.000Z")),
          sessionRow(key, "Research notes", Date.parse("2026-07-01T15:00:00.000Z")),
        ]),
      },
      sessionKey: "agent:main:main",
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await row.waitFor({ state: "visible", timeout: 10_000 });
      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await page
        .locator("openclaw-session-menu")
        .getByRole("menuitem", { name: "Delete…" })
        .click();

      const confirmModal = await waitForConfirmModal(page);
      await captureUiProof(page, "sidebar-delete-session-confirm.png");
      await gateway.deferNext("sessions.delete");
      await confirmModal.getByRole("button", { name: "Delete", exact: true }).evaluate((button) => {
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error("expected delete confirmation button");
        }
        button.click();
        button.click();
      });

      const request = await gateway.waitForRequest("sessions.delete");
      expect(request).toMatchObject({
        params: { deleteTranscript: true, expectedSessionId: `session:${key}`, key },
      });
      await expectRequestCountStable(gateway, "sessions.delete", 1);
      await gateway.rejectDeferred("sessions.delete", {
        code: "INVALID_REQUEST",
        message: `Session ${key} changed before deletion. Retry.`,
      });
      const visibleError = page.locator("[data-sidebar-session-error]");
      await expect
        .poll(() => visibleError.textContent())
        .toContain("changed before deletion. Retry.");
      expect(await visibleError.textContent()).not.toContain("GatewayRequestError");
      await row.waitFor({ state: "visible" });
      await captureUiProof(page, "sidebar-delete-session-replaced-error.png");
      expect(nativeDialogs).toEqual([]);
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(
          path.join(uiProofArtifactDir, "sidebar-delete-session-replaced.webm"),
        );
      }
    }
  });
});

import path from "node:path";
import { expect, it } from "vitest";
import {
  captureUiProof,
  captureUiProofEnabled,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionRow,
  sessionsListResponse,
  uiProofArtifactDir,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps externally discovered newest sessions above Show more", async () => {
    const baseTime = Date.parse("2026-08-14T18:00:00.000Z");
    const olderRows = Array.from({ length: 10 }, (_, index) => ({
      ...sessionRow(
        `agent:main:older-${index}`,
        `Older session ${index}`,
        baseTime - index * 1_000,
      ),
      createdAt: baseTime - index * 1_000,
    }));
    const newestKey = "agent:main:external-new";
    const newestRow = {
      ...sessionRow(newestKey, "External newest", baseTime + 1_000),
      createdAt: baseTime + 1_000,
    };
    // Sticky membership: rows the operator already saw stay visible when a
    // newer session enters the page, so the full prior page remains.
    const expectedVisibleKeys = [newestKey, ...olderRows.map((row) => row.key)];
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
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "sessions.list": sessionsListResponse(olderRows),
      },
      sessionKey: olderRows[0]?.key,
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const rows = page.locator(".sidebar-recent-session");
      await expect.poll(() => rows.count(), { timeout: 10_000 }).toBe(10);
      const retainedSessionKey = olderRows[5]!.key;
      await rows.nth(5).evaluate((row) => Reflect.set(row, "__retainedSessionRow", true));
      await captureUiProof(page, "sidebar-created-sort-before-refresh.png");
      const initialListCount = (await gateway.getRequests("sessions.list")).length;

      await gateway.setMethodResponse(
        "sessions.list",
        sessionsListResponse([...olderRows, newestRow]),
      );
      await gateway.emitGatewayEvent("sessions.changed", {
        key: newestKey,
        kind: "direct",
        reason: "create",
        sessionKey: newestKey,
        updatedAt: newestRow.updatedAt,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(initialListCount);
      await expect
        .poll(() =>
          rows.evaluateAll((elements) =>
            elements.map((element) => element.getAttribute("data-session-key")),
          ),
        )
        .toEqual(expectedVisibleKeys);
      expect(
        await page
          .locator(`.sidebar-recent-session[data-session-key="${retainedSessionKey}"]`)
          .evaluate((row) => Reflect.get(row, "__retainedSessionRow")),
      ).toBe(true);
      await captureUiProof(page, "sidebar-created-sort-after-refresh.png");

      expect(await rows.count()).toBe(11);
      expect(
        await rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-session-key")),
        ),
      ).toEqual(expectedVisibleKeys);
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(
          path.join(uiProofArtifactDir, "sidebar-created-sort-external-session.webm"),
        );
      }
    }
  });
});

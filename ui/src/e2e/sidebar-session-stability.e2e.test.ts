import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  captureUiProof,
  captureUiProofEnabled,
  controlUiSessionPath,
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("keeps visible sessions ordered and an active child expanded across run completion", async () => {
    const baseTime = Date.parse("2026-08-14T18:00:00.000Z");
    const parentKey = "agent:main:stability-parent";
    const childKey = "agent:main:stability-child";
    const runId = "sidebar-stability-run";
    const siblingRows = Array.from({ length: 10 }, (_, index) => ({
      ...sessionRow(`agent:main:stability-${index}`, `Stable session ${index}`, baseTime - index),
      createdAt: baseTime - index,
    }));
    const parentRow = {
      ...sessionRow(parentKey, "Parent session", baseTime + 100, {
        childSessions: [childKey],
      }),
      createdAt: baseTime + 100,
    };
    const childRow = {
      ...sessionRow(childKey, "Child session", baseTime + 50, {
        hasActiveRun: true,
        spawnedBy: parentKey,
        startedAt: baseTime,
        status: "running",
      }),
      activeRunIds: [runId],
      createdAt: baseTime + 50,
    };
    const expectedVisibleKeys = [
      parentKey,
      childKey,
      ...siblingRows.slice(0, 9).map(({ key }) => key),
    ];
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
      methodResponses: {
        "sessions.list": sessionsListResponse([parentRow, childRow, ...siblingRows]),
      },
      sessionKey: childKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, childKey));
      const rows = page.locator(".sidebar-recent-session");
      const visibleKeys = () =>
        rows.evaluateAll((elements) =>
          elements.map((element) => element.getAttribute("data-session-key")),
        );
      const childToggle = page.locator(`[data-child-session-toggle="${parentKey}"]`);
      await expect.poll(visibleKeys, { timeout: 10_000 }).toEqual(expectedVisibleKeys);
      await expect.poll(() => childToggle.getAttribute("aria-expanded")).toBe("true");
      await captureUiProof(suite, page, "sidebar-session-stability-running.png");

      await gateway.emitGatewayEvent("agent", {
        data: { name: "bash" },
        runId,
        sessionKey: childKey,
        stream: "tool",
      });
      expect(await visibleKeys()).toEqual(expectedVisibleKeys);

      const completedChild = {
        ...childRow,
        activeRunIds: [],
        endedAt: baseTime + 200,
        hasActiveRun: false,
        status: "done",
        updatedAt: baseTime + 200,
      };
      await gateway.setMethodResponse(
        "sessions.list",
        sessionsListResponse([parentRow, completedChild, ...siblingRows]),
      );
      const listCount = (await gateway.getRequests("sessions.list")).length;
      await gateway.emitGatewayEvent("sessions.changed", {
        activeRunIds: [],
        endedAt: completedChild.endedAt,
        hasActiveRun: false,
        key: childKey,
        kind: "direct",
        reason: "lifecycle",
        sessionKey: childKey,
        status: "done",
        updatedAt: completedChild.updatedAt,
      });
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list")).length)
        .toBeGreaterThan(listCount);
      await expect.poll(visibleKeys).toEqual(expectedVisibleKeys);

      const nextSessionKey = siblingRows[0]?.key;
      if (!nextSessionKey) {
        throw new Error("expected a visible sibling session");
      }
      await page
        .locator(`[data-session-key="${nextSessionKey}"] a.sidebar-recent-session__link`)
        .click();
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath(nextSessionKey));
      await expect.poll(() => childToggle.getAttribute("aria-expanded")).toBe("true");
      await expect.poll(visibleKeys).toEqual(expectedVisibleKeys);
      await captureUiProof(suite, page, "sidebar-session-stability-completed.png");
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(suite.artifactDir, "sidebar-session-stability.webm"));
      }
    }
  });
});

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
  it.each([
    { status: "running", label: "Active run", playState: "running" },
    { status: "queued", label: "Queued", playState: "paused" },
  ])("shows a $playState ring for $status work", async ({ status, label, playState }) => {
    const mainKey = "agent:main:main";
    const queuedKey = "agent:main:queued-repair";
    const context = await suite.browser.newContext({
      colorScheme: "dark",
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
        "sessions.list": sessionsListResponse([
          sessionRow(mainKey, "Main", 2),
          sessionRow(queuedKey, "Queued repair", 1, {
            hasActiveRun: true,
            status,
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
      const ring = row.locator(".sidebar-session-indicator .session-glyph__ring");
      expect(await ring.count()).toBe(1);
      expect(await ring.getAttribute("aria-label")).toBe(label);
      expect(
        await row.getByRole("link", { name: `${label} Queued repair`, exact: true }).count(),
      ).toBe(1);
      expect(await ring.evaluate((element) => getComputedStyle(element).animationName)).toBe(
        "session-run-spin",
      );
      expect(await ring.evaluate((element) => getComputedStyle(element).animationPlayState)).toBe(
        playState,
      );
      await captureUiProof(suite, page, `${status}-session-ring.png`);

      const listRequests = (await gateway.getRequests("sessions.list")).length;
      await gateway.setSessionsListResponse(
        sessionsListResponse([
          sessionRow(mainKey, "Main", 2),
          sessionRow(queuedKey, "Queued repair", 1, {
            hasActiveRun: true,
            status: "running",
            unread: true,
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
      await expect
        .poll(() =>
          row.locator(".sidebar-recent-session__link").evaluate((link) => {
            const descriptionId = link.getAttribute("aria-describedby");
            return descriptionId
              ? link.ownerDocument.getElementById(descriptionId)?.textContent
              : null;
          }),
        )
        .toBe("Unread");
      expect(await row.locator(".session-row-state").count()).toBe(0);
      expect(await row.getByRole("img", { name: "Unread", exact: true }).count()).toBe(0);
      const accessibility = await context.newCDPSession(page);
      const { nodes } = await accessibility.send("Accessibility.getFullAXTree");
      const linkNode = nodes.find(
        (node) => node.role?.value === "link" && node.name?.value === "Active run Queued repair",
      );
      expect(linkNode?.description?.value).toBe("Unread");
      expect(
        `${linkNode?.name?.value} ${linkNode?.description?.value}`.match(/Unread/g),
      ).toHaveLength(1);
      await accessibility.detach();
      expect(
        await row.getByRole("link", { name: "Active run Queued repair", exact: true }).count(),
      ).toBe(1);
      expect(await row.locator(".sidebar-recent-session__subtitle").count()).toBe(0);
      expect(await ring.count()).toBe(1);
      expect(await ring.getAttribute("aria-label")).toBe("Active run");
      expect(await ring.evaluate((element) => getComputedStyle(element).animationPlayState)).toBe(
        "running",
      );
      await captureUiProof(suite, page, `${status}-session-running.png`);
    } finally {
      await context.close();
      if (proofVideo) {
        await proofVideo.saveAs(path.join(suite.artifactDir, `${status}-session-ring.webm`));
      }
    }
  });
});

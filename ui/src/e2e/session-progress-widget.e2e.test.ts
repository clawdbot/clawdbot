import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { chatSessionListResponse } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session progress dashboard widget",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:progress-dashboard";
let proofDir: string;
beforeEach(() => {
  proofDir = createControlUiE2eArtifactDir("session-progress-widget");
});

suite.define(() => {
  it.each([
    { height: 900, name: "desktop", width: 1440, routeKey: sessionKey },
    { height: 844, name: "mobile", width: 390, routeKey: sessionKey },
    { height: 900, name: "bare-route", width: 1440, routeKey: "progress-dashboard" },
  ])("keeps an older progress card paused during a later run on $name", async (viewport) => {
    await suite.withPage({ viewport }, async ({ page }) => {
      const now = Date.now();
      const gateway = await installMockGateway(page, {
        sessionKey,
        controlUiWidgetKinds: [
          { pluginId: "session", kind: "session:progress", label: "Session progress" },
        ],
        featureMethods: [
          "board.get",
          "chat.metadata",
          "chat.startup",
          "progressCard.get",
          "sessions.list",
          "sessions.patch",
        ],
        methodResponses: {
          "board.get": {
            sessionKey,
            revision: 1,
            tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
            widgets: [
              {
                name: "session-progress",
                tabId: "main",
                title: "Session progress",
                contentKind: "plugin",
                pluginKind: "session:progress",
                sizeW: 6,
                sizeH: 5,
                position: 0,
                grantState: "none",
                revision: 1,
              },
            ],
          },
          "progressCard.get": {
            card: {
              sessionKey,
              revision: 3,
              updatedAt: now - 5 * 60_000,
              markdown: "**Earlier task** remains available for reference.",
              steps: [
                { step: "Finish the earlier task", status: "completed" },
                { step: "Archive the earlier checklist", status: "in_progress" },
                { step: "Start unrelated work", status: "pending" },
              ],
            },
          },
          "sessions.list": chatSessionListResponse([
            {
              hasActiveRun: true,
              key: sessionKey,
              kind: "direct",
              label: "Later active run",
              startedAt: now - 60_000,
              status: "running",
              updatedAt: now,
            },
          ]),
        },
      });
      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, rawKey, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({
              boardSessionViews: { [key]: { activeTabId: "main" } },
              ...(rawKey === key
                ? {}
                : {
                    chatSplitLayout: {
                      activePaneId: "p1",
                      columns: [
                        { id: "c1", panes: [{ id: "p1", sessionKey: key }], paneWeights: [1] },
                        { id: "c2", panes: [{ id: "p2", sessionKey: rawKey }], paneWeights: [1] },
                      ],
                      columnWeights: [0.5, 0.5],
                    },
                  }),
            }),
          );
        },
        { key: sessionKey, rawKey: viewport.routeKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const surface =
        viewport.routeKey === sessionKey ? page : page.locator(".chat-split-view__column").nth(1);
      const card = surface.locator('[data-progress-card-placement="board"]');
      if (viewport.routeKey !== sessionKey) {
        await expect
          .poll(() =>
            surface
              .locator("openclaw-chat-pane")
              .evaluate((element) => (element as HTMLElement & { sessionKey: string }).sessionKey),
          )
          .toBe(viewport.routeKey);
        await gateway.waitForRequest("board.get", { match: { sessionKey: viewport.routeKey } });
        await surface.locator("openclaw-session-progress-widget").waitFor();
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(proofDir, "session-progress-widget-bare-route-admission.png"),
        });
        await expect
          .poll(() =>
            surface
              .locator("openclaw-board-view")
              .evaluate((element) => (element as HTMLElement & { session: unknown }).session),
          )
          .toEqual({ sessionKey: viewport.routeKey, agentId: "main" });
      }
      await card.waitFor();
      expect(await card.locator("iframe").count()).toBe(0);
      await expect.poll(() => card.textContent()).toContain("Earlier task");
      await expect.poll(() => card.textContent()).toContain("Archive the earlier checklist");
      await expect
        .poll(() => card.locator(".session-progress-card__heading").textContent())
        .toContain("1/3");
      await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);

      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, `session-progress-widget-${viewport.name}.png`),
      });
      expect(await card.locator(".session-run-spinner").count()).toBe(0);
      const paused = card.locator(".session-progress-card__step--paused");
      expect(await paused.count()).toBe(1);
      expect(await paused.getAttribute("aria-label")).toBe("Archive the earlier checklist, paused");

      const progressReads = await gateway.getRequests("progressCard.get");
      await gateway.deferNext("progressCard.get");
      await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 4 });
      await gateway.waitForRequest("progressCard.get", { after: progressReads.length });
      await gateway.rejectDeferred("progressCard.get", {
        code: "UNAVAILABLE",
        message: "Refresh temporarily unavailable",
      });
      const error = surface.locator('[data-test-id="session-progress-error"]');
      await error.waitFor();
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, `session-progress-widget-${viewport.name}-refresh-failed.png`),
      });
      await expect.poll(() => card.count()).toBe(1);
      expect(await card.textContent()).toContain("Earlier task");
      const visibility = await card
        .locator(".session-progress-card__heading")
        .evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const body = element.closest(".board-widget__body")!.getBoundingClientRect();
          return {
            headingInsideWidgetAndViewport:
              bounds.top >= Math.max(0, body.top) &&
              bounds.bottom <= Math.min(window.innerHeight, body.bottom) &&
              bounds.left >= Math.max(0, body.left) &&
              bounds.right <= Math.min(window.innerWidth, body.right),
          };
        });
      expect(visibility.headingInsideWidgetAndViewport).toBe(true);
      expect(await error.getByRole("button", { name: "Retry", exact: true }).count()).toBe(1);

      await gateway.setMethodResponse("progressCard.get", {
        card: {
          sessionKey,
          revision: 4,
          updatedAt: now,
          markdown: "**Refreshed task** is available again.",
          steps: [{ step: "Recovered progress", status: "completed" }],
        },
      });
      await error.getByRole("button", { name: "Retry", exact: true }).click();
      await expect.poll(() => card.textContent()).toContain("Refreshed task");
      await expect.poll(() => error.count()).toBe(0);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, `session-progress-widget-${viewport.name}-refresh-recovered.png`),
      });

      const readsBeforeDenial = await gateway.getRequests("progressCard.get");
      await gateway.deferNext("progressCard.get");
      await gateway.emitGatewayEvent("progressCard.changed", { sessionKey, revision: 5 });
      await gateway.waitForRequest("progressCard.get", { after: readsBeforeDenial.length });
      await gateway.rejectDeferred("progressCard.get", {
        code: "INVALID_REQUEST",
        message: "Participation required",
        details: { code: "SESSION_PARTICIPATION_REQUIRED" },
      });
      await expect
        .poll(() => error.textContent())
        .toContain("Select a session you can access or change sharing for this session.");
      await expect.poll(() => card.count()).toBe(0);
      expect(await error.getByRole("button").count()).toBe(0);
      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, `session-progress-widget-${viewport.name}-access-denied.png`),
      });
    });
  });
});

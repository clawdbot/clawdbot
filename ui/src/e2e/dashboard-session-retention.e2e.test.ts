import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { openSlot, setSidebarOpen } from "../pages/chat/sidebar-layout.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionPath,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI retained dashboard sessions",
  startServerBeforeBrowser: true,
});

const alphaKey = "agent:main:dashboard-alpha";
const betaKey = "agent:main:dashboard-beta";

function dashboardPath(key: string): string {
  return controlUiSessionPath(key).replace(/^\/chat\//u, "/dashboard/");
}

function dashboardSnapshot(key: string, prefix: string) {
  return {
    sessionKey: key,
    revision: 1,
    tabs: [
      { tabId: `${prefix}-main`, title: `${prefix} main`, position: 0, chatDock: "right" },
      { tabId: `${prefix}-other`, title: `${prefix} other`, position: 1, chatDock: "right" },
    ],
    widgets: [],
  };
}

suite.define(() => {
  it("does not mount an unopened dashboard after leaving another session's open panel", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessionKey: alphaKey,
        featureMethods: ["board.get", "browser.request", "chat.metadata", "chat.startup"],
        methodResponses: {
          "board.get": {
            cases: [
              {
                match: { sessionKey: alphaKey },
                response: { sessionKey: alphaKey, revision: 1, tabs: [], widgets: [] },
              },
              { match: { sessionKey: betaKey }, response: dashboardSnapshot(betaKey, "beta") },
            ],
          },
          "browser.request": {
            cases: [
              { match: { method: "GET", path: "/tabs" }, response: { running: false, tabs: [] } },
            ],
          },
          "sessions.list": {
            count: 2,
            defaults: { contextTokens: null, model: "gpt-5.6-luna", modelProvider: "openai" },
            path: "",
            sessions: [
              { key: alphaKey, kind: "direct", label: "Alpha chat", updatedAt: 2 },
              { key: betaKey, kind: "direct", label: "Beta chat", updatedAt: 1 },
            ],
            ts: Date.now(),
          },
        },
      });
      await page.addInitScript(
        ({ storageKey, key, layout }) => {
          const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
          settings.sidebarSessionLayouts = { [key]: layout };
          localStorage.setItem(storageKey, JSON.stringify(settings));
        },
        {
          storageKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
          key: betaKey,
          layout: setSidebarOpen(openSlot({ columns: [] }, "dashboard"), false),
        },
      );
      await page.goto(new URL(controlUiSessionPath(alphaKey), suite.server.baseUrl).href);
      await openChatSidePanelType(page, "Browser");
      const alphaRegion = await page.locator("openclaw-chat-sidebar-region").elementHandle();
      expect(alphaRegion).not.toBeNull();
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${betaKey}"] a.sidebar-recent-session__link`,
        )
        .click();
      await page.waitForURL(new URL(controlUiSessionPath(betaKey), suite.server.baseUrl).href);
      await expect
        .poll(() => gateway.getRequests("board.get"))
        .toContainEqual(
          expect.objectContaining({ params: expect.objectContaining({ sessionKey: betaKey }) }),
        );
      const betaPane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      const betaRegion = betaPane.locator("openclaw-chat-sidebar-region");
      await betaRegion.waitFor({ state: "attached" });
      expect(
        await betaRegion.evaluate((element, previous) => element === previous, alphaRegion),
      ).toBe(false);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await betaPane.locator('[data-region-header="side"]').isVisible()).toBe(false);
      expect(await betaPane.locator("openclaw-board-view").count()).toBe(0);
      await betaPane.getByRole("button", { name: "Side panel", exact: true }).click();
      await betaPane.locator('[data-board-tab-id="beta-main"]').waitFor();
    });
  });

  it("shows a warmed dashboard immediately while its refresh is pending", async () => {
    const recordProof = process.env.OPENCLAW_UI_E2E_RECORD === "1";
    if (recordProof) {
      await mkdir(path.join(suite.artifactDir, "dashboard-session-retention"), { recursive: true });
    }
    const context = await suite.browser.newContext({
      viewport: { height: 900, width: 1280 },
      ...(recordProof
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "dashboard-session-retention"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: alphaKey,
      featureMethods: ["board.get", "chat.metadata", "chat.startup"],
      methodResponses: {
        "board.get": {
          cases: [
            { match: { sessionKey: alphaKey }, response: dashboardSnapshot(alphaKey, "alpha") },
            { match: { sessionKey: betaKey }, response: dashboardSnapshot(betaKey, "beta") },
          ],
        },
        "sessions.list": {
          count: 2,
          defaults: { contextTokens: null, model: "gpt-5.6-luna", modelProvider: "openai" },
          path: "",
          sessions: [
            {
              boardFace: "dashboard",
              key: alphaKey,
              kind: "direct",
              label: "Alpha dashboard",
              updatedAt: 2,
            },
            {
              boardFace: "dashboard",
              key: betaKey,
              kind: "direct",
              label: "Beta dashboard",
              updatedAt: 1,
            },
          ],
          ts: Date.now(),
        },
      },
    });

    try {
      await page.goto(new URL(dashboardPath(alphaKey), suite.server.baseUrl).href);
      const alphaTab = page.locator('[data-board-tab-id="alpha-main"]');
      await alphaTab.waitFor();
      if (recordProof) {
        await page.screenshot({
          path: path.join(
            path.join(suite.artifactDir, "dashboard-session-retention"),
            "01-alpha-warmed.png",
          ),
        });
      }

      const sessionLink = (key: string) =>
        page.locator(
          `.sidebar-recent-session[data-session-key="${key}"] a.sidebar-recent-session__link`,
        );
      const dashboardActive = (key: string) =>
        page.locator("openclaw-chat-pane").evaluateAll((panes, sessionKey) => {
          const pane = panes.find(
            (candidate) => Reflect.get(candidate, "sessionKey") === sessionKey,
          );
          const board = pane?.querySelector("openclaw-board-view");
          return board ? Reflect.get(board, "active") : null;
        }, key);
      await sessionLink(betaKey).click();
      await page.locator('[data-board-tab-id="beta-main"]').waitFor();
      await expect.poll(() => new URL(page.url()).pathname).toBe(dashboardPath(betaKey));
      await expect.poll(() => dashboardActive(alphaKey)).toBe(false);
      await expect.poll(() => dashboardActive(betaKey)).toBe(true);
      if (recordProof) {
        await page.screenshot({
          path: path.join(
            path.join(suite.artifactDir, "dashboard-session-retention"),
            "02-beta-selected.png",
          ),
        });
      }

      await gateway.deferNext("board.get", { sessionKey: alphaKey });
      await sessionLink(alphaKey).click();
      await alphaTab.waitFor({ state: "visible", timeout: 1_000 });
      expect(await alphaTab.textContent()).toContain("alpha main");
      await expect.poll(() => dashboardActive(alphaKey)).toBe(true);
      await expect.poll(() => dashboardActive(betaKey)).toBe(false);
      if (recordProof) {
        await page.screenshot({
          path: path.join(
            path.join(suite.artifactDir, "dashboard-session-retention"),
            "03-alpha-retained.png",
          ),
        });
      }
    } finally {
      const video = page.video();
      await context.close();
      if (recordProof && video) {
        await video.saveAs(
          path.join(
            path.join(suite.artifactDir, "dashboard-session-retention"),
            "dashboard-session-retention.webm",
          ),
        );
      }
    }
  });
});

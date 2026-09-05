import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard side-panel selection",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard";
const boardSnapshot = {
  sessionKey,
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [],
};

suite.define(() => {
  it("restores the saved main and side selection on ordinary dashboard revisits", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storageKey }) => {
          const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<
            string,
            unknown
          >;
          settings.boardSessionViews = { [key]: { activeTabId: "main" } };
          const sidebarSessionLayouts =
            settings.sidebarSessionLayouts && typeof settings.sidebarSessionLayouts === "object"
              ? (settings.sidebarSessionLayouts as Record<string, unknown>)
              : {};
          settings.sidebarSessionLayouts = {
            ...sidebarSessionLayouts,
            [key]: sidebarSessionLayouts[key] ?? {
              columns: [
                {
                  id: "side-panel-column",
                  side: "right",
                  panels: [
                    { id: "terminal", slot: "terminal" },
                    { id: "dashboard", slot: "dashboard" },
                    { id: "conversation", slot: "conversation" },
                  ],
                  activePanelId: "dashboard",
                  height: 360,
                  width: 480,
                },
              ],
              dock: "right",
              mainPanelId: "terminal",
              open: true,
            },
          };
          localStorage.setItem(storageKey, JSON.stringify(settings));
        },
        { key: sessionKey, storageKey: settingsKey },
      );
      await installMockGateway(page, {
        sessionKey,
        featureMethods: ["board.get", "chat.metadata", "chat.startup", "terminal.open"],
        methodResponses: { "board.get": boardSnapshot },
        terminalEnabled: true,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      await page.locator(".board-session-surface").waitFor();
      const terminal = page.locator('[data-panel-slot="terminal"][data-region="main"]');
      const dashboard = page.getByRole("tab", { name: "Dashboard", exact: true });
      await expect.poll(() => dashboard.getAttribute("aria-selected")).toBe("true");
      await terminal.waitFor();
      await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);

      await page.reload();
      await page.locator(".board-session-surface").waitFor();
      await expect.poll(() => dashboard.getAttribute("aria-selected")).toBe("true");
      await terminal.waitFor();
    });
  });
});

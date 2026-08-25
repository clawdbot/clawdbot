import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
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
  it("restores the previously selected side-panel tab", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
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
                panels: [{ id: "terminal", slot: "terminal" }],
                activePanelId: "terminal",
                height: 360,
                width: 480,
              },
            ],
            dock: "right",
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

    try {
      await page.goto(`${suite.server.baseUrl}dashboard`);
      await page.locator(".board-session-surface").waitFor();
      const terminal = page.getByRole("tab", { name: "Terminal", exact: true });
      const chat = page.getByRole("tab", { name: "Board chat", exact: true });
      await expect.poll(() => terminal.getAttribute("aria-selected")).toBe("true");

      await chat.click();
      await expect.poll(() => chat.getAttribute("aria-selected")).toBe("true");
      await page.reload();
      await expect.poll(() => chat.getAttribute("aria-selected")).toBe("true");
    } finally {
      await context.close();
    }
  });
});

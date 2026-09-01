import type { Page } from "playwright";
import { expect, it } from "vitest";
import { workboardUi } from "../pages/workboard/workboard.e2e.test-support.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Workboard board widget layout",
  startServerBeforeBrowser: true,
});

const sessionKey = "agent:main:dashboard:workboard-layout";
const boardSnapshot = {
  sessionKey,
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [
    {
      name: "workboard-board",
      tabId: "main",
      title: "Platform board",
      contentKind: "plugin",
      pluginKind: "workboard:board",
      props: { boardId: "platform" },
      sizeW: 12,
      sizeH: 5,
      position: 0,
      grantState: "none",
      revision: 1,
    },
  ],
};

const cards = ["ready", "running", "done"].map((status, index) => ({
  id: `card-${status}`,
  title: `${status} card`,
  status,
  priority: "normal",
  labels: [],
  position: (index + 1) * 1_000,
  createdAt: 1,
  updatedAt: 2,
  agentId: "main",
  metadata: { automation: { boardId: "platform" } },
}));

async function showDashboard(page: Page): Promise<void> {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, storageKey }) => {
      const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<
        string,
        unknown
      >;
      settings.boardSessionViews = { [key]: { activeTabId: "main" } };
      localStorage.setItem(storageKey, JSON.stringify(settings));
    },
    { key: sessionKey, storageKey: settingsKey },
  );
}

suite.define(() => {
  it("preserves the compact horizontal grid at desktop and mobile widths", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      await installMockGateway(page, {
        ...workboardUi,
        sessionKey,
        controlUiWidgetKinds: [
          { pluginId: "workboard", kind: "workboard:board", label: "Workboard board" },
        ],
        featureMethods: ["board.get", "chat.metadata", "chat.startup", "workboard.cards.list"],
        methodResponses: {
          "board.get": boardSnapshot,
          "workboard.cards.list": { cards, statuses: ["ready", "running", "done"] },
        },
      });
      await showDashboard(page);
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));

      const board = page.locator('[data-test-id="workboard-board-widget"] .workboard-board');
      await board.waitFor();
      const desktop = await board.evaluate((element) => ({
        display: getComputedStyle(element).display,
        flow: getComputedStyle(element).gridAutoFlow,
        widths: [...element.querySelectorAll<HTMLElement>(".workboard-column")].map(
          (column) => column.getBoundingClientRect().width,
        ),
      }));
      expect(desktop.display).toBe("grid");
      expect(desktop.flow).toBe("column");
      expect(desktop.widths.every((width) => width >= 239 && width <= 241)).toBe(true);

      await page.setViewportSize({ height: 900, width: 700 });
      const mobile = await board.evaluate((element) => {
        const [first, second] = [...element.querySelectorAll<HTMLElement>(".workboard-column")];
        return {
          display: getComputedStyle(element).display,
          firstTop: first?.getBoundingClientRect().top,
          secondLeft: second?.getBoundingClientRect().left,
          secondTop: second?.getBoundingClientRect().top,
        };
      });
      expect(mobile.display).toBe("grid");
      expect(mobile.secondTop).toBe(mobile.firstTop);
      expect(mobile.secondLeft).toBeGreaterThan(0);
    });
  });
});

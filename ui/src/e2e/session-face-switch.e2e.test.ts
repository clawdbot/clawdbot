import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session face switch",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:dashboard";
const boardSnapshot = {
  sessionKey,
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [],
};

async function showDashboard(page: Page): Promise<void> {
  const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, settingsKey }) => {
      const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Record<
        string,
        unknown
      >;
      settings.boardSessionViews = {
        ...(settings.boardSessionViews as Record<string, unknown> | undefined),
        [key]: { activeTabId: "main" },
      };
      localStorage.setItem(settingsKey, JSON.stringify(settings));
    },
    { key: sessionKey, settingsKey: storageKey },
  );
}

suite.define(() => {
  it("centers session face icons beside their labels", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 760, width: 1600 } });
    const page = await context.newPage();
    await installMockGateway(page, {
      sessionKey,
      featureMethods: ["board.get", "chat.metadata", "chat.startup"],
      methodResponses: { "board.get": boardSnapshot },
    });
    await showDashboard(page);

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const chatOption = page.locator('wa-radio.settings-segmented__btn[value="chat"]');
      await chatOption.waitFor();

      for (const viewport of [
        { height: 844, width: 390 },
        { height: 1024, width: 768 },
        { height: 768, width: 1366 },
        { height: 900, width: 1440 },
      ]) {
        await page.setViewportSize(viewport);
        const geometry = await chatOption.evaluate((option) => {
          const icon = option.querySelector("svg")?.getBoundingClientRect();
          const label = option.querySelector(".chat-pane__face-label")?.getBoundingClientRect();
          if (!icon || !label) {
            throw new Error("Session face option did not render its icon and label");
          }
          return {
            gap: label.left - icon.right,
            verticalCenterDelta: Math.abs(
              icon.top + icon.height / 2 - (label.top + label.height / 2),
            ),
          };
        });
        expect(geometry.gap).toBe(6);
        expect(geometry.verticalCenterDelta).toBeLessThanOrEqual(0.5);
      }
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        const proofDir = path.join(suite.artifactDir, "session-face-switch");
        await mkdir(proofDir, { recursive: true });
        await page.setViewportSize({ height: 760, width: 1600 });
        await page.locator(".chat-pane__face-switch").screenshot({
          path: path.join(proofDir, "01-labels-after.png"),
        });
      }
    } finally {
      await context.close();
    }
  });
});

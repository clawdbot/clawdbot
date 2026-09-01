import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
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
  it("renders the live session progress card through an advertised dashboard kind", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
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
              updatedAt: 3,
              markdown: "**Dashboard tile** follows the live session card.",
              steps: [
                { step: "Inspect dashboard seams", status: "completed" },
                { step: "Render the progress tile", status: "in_progress" },
                { step: "Capture browser proof", status: "pending" },
              ],
            },
          },
        },
      });
      const storageKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
      await page.addInitScript(
        ({ key, storage }) => {
          localStorage.setItem(
            storage,
            JSON.stringify({ boardSessionViews: { [key]: { activeTabId: "main" } } }),
          );
        },
        { key: sessionKey, storage: storageKey },
      );

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const card = page.locator('[data-progress-card-placement="board"]');
      await card.waitFor();
      expect(await card.locator("iframe").count()).toBe(0);
      await expect.poll(() => card.textContent()).toContain("Dashboard tile");
      await expect.poll(() => card.textContent()).toContain("Inspect dashboard seams");
      await expect.poll(() => card.textContent()).toContain("Render the progress tile");
      await expect.poll(() => card.textContent()).toContain("Capture browser proof");
      await expect
        .poll(() => card.locator(".session-progress-card__heading").textContent())
        .toContain("1/3");
      await expect.poll(() => gateway.getRequests("progressCard.get")).toHaveLength(1);

      await page.screenshot({
        animations: "disabled",
        fullPage: true,
        path: path.join(proofDir, "session-progress-widget.png"),
      });
    });
  });
});

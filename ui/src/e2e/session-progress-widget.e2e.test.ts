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
    { height: 900, name: "desktop", width: 1440 },
    { height: 844, name: "mobile", width: 390 },
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
    });
  });
});

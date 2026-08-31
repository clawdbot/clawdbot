import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI dashboard grant failure",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:dashboard-grant-failure";

suite.define(() => {
  it("keeps a network-capability decision retryable and toasts when Allow fails", async () => {
    const recordProof = process.env.OPENCLAW_UI_E2E_RECORD === "1";
    if (recordProof) {
      await mkdir(path.join(suite.artifactDir, "workboard-grant-failure"), { recursive: true });
    }
    const context = await suite.browser.newContext({
      viewport: { height: 900, width: 1280 },
      ...(recordProof
        ? {
            recordVideo: {
              dir: path.join(suite.artifactDir, "workboard-grant-failure"),
              size: { height: 900, width: 1280 },
            },
          }
        : {}),
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: ["board.get", "board.widget.grant", "chat.metadata", "chat.startup"],
      methodResponses: {
        "board.get": {
          sessionKey,
          revision: 1,
          tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
          widgets: [
            {
              name: "status",
              tabId: "main",
              title: "Status",
              contentKind: "html",
              sizeW: 6,
              sizeH: 4,
              position: 0,
              grantState: "pending",
              declared: { netOrigins: ["https://api.example.com"] },
              revision: 1,
            },
          ],
        },
        "board.widget.grant": {
          __mockError: {
            code: "UNAVAILABLE",
            message: "internal capability service detail",
          },
        },
      },
    });
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

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const pending = page.locator('[data-test-id="board-pending"]');
      const allow = pending.getByRole("button", { name: "Allow" });
      const reject = pending.getByRole("button", { name: "Reject" });
      await pending.waitFor();
      await gateway.deferNext("board.get", { sessionKey });
      await allow.click();

      const request = await gateway.waitForRequest("board.widget.grant");
      expect(request.params).toEqual({
        sessionKey,
        name: "status",
        decision: "granted",
        revision: 1,
      });
      const toast = page.locator("openclaw-toast-host .app-toast");
      await toast.waitFor();
      expect(await toast.textContent()).toContain("Could not allow widget access. Try again.");
      expect(await toast.textContent()).not.toContain("internal capability service detail");
      await expect.poll(() => allow.isEnabled()).toBe(true);
      expect(await reject.isEnabled()).toBe(true);
      await pending.waitFor();
      await page.locator('[data-test-id="board-widget-action-error"]').waitFor();
      if (recordProof) {
        await page.screenshot({
          path: path.join(
            path.join(suite.artifactDir, "workboard-grant-failure"),
            "grant-failed.png",
          ),
        });
      }
    } finally {
      const video = page.video();
      await context.close();
      if (recordProof && video) {
        await video.saveAs(
          path.join(
            path.join(suite.artifactDir, "workboard-grant-failure"),
            "workboard-grant-failure.webm",
          ),
        );
      }
    }
  });
});

import path from "node:path";
import type { Locator, Page } from "playwright";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  controlUiSessionUrl,
  installMockGateway,
  navigateToControlUiSession,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatSidePanelType } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "session companion clear",
  startServerBeforeBrowser: true,
});

const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("chat-session-companion-clear", artifactRoot)
    : undefined;
});
const answer = "Keep this companion answer visible until the reset succeeds.";
const initiatingSessionKey = "agent:main:companion-clear";
const nextSessionKey = "agent:main:companion-next";
const resetError = "Companion reset unavailable during reconnect";

type CompanionSurface = {
  companion: Locator;
  gateway: MockGatewayControls;
  menu: Locator;
  page: Page;
};

async function withCompanion(run: (surface: CompanionSurface) => Promise<void>): Promise<void> {
  await suite.withPage(
    {
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 800, width: 1200 },
      ...(artifactDir
        ? { recordVideo: { dir: artifactDir, size: { height: 800, width: 1200 } } }
        : {}),
    },
    async ({ page }) => {
      const gateway = await installMockGateway(page, {
        methodResponses: {
          "sessions.companion.reset": {
            __mockError: { code: "UNAVAILABLE", message: resetError },
          },
          "sessions.companion.state": {
            cases: [
              {
                match: { sessionKey: initiatingSessionKey },
                response: {
                  exchanges: [{ question: "What changed?", answer, ts: Date.now() - 1_000 }],
                },
              },
              { match: { sessionKey: nextSessionKey }, response: { exchanges: [] } },
            ],
          },
          "sessions.list": {
            count: 2,
            defaults: { contextTokens: null, model: "gpt-5.5", modelProvider: "openai" },
            path: "",
            sessions: [
              { key: initiatingSessionKey, kind: "direct", label: "Original", updatedAt: 2 },
              { key: nextSessionKey, kind: "direct", label: "Next", updatedAt: 1 },
            ],
            ts: Date.now(),
          },
        },
        sessionKey: initiatingSessionKey,
      });

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, initiatingSessionKey));
      const stateRequest = await gateway.waitForRequest("sessions.companion.state");
      expect(stateRequest.params).toEqual({
        agentId: "main",
        sessionKey: initiatingSessionKey,
      });
      await openChatSidePanelType(page, "Side chat");
      const companion = page.locator("openclaw-chat-session-rail");
      await companion.getByText(answer, { exact: true }).waitFor();
      // The embedded rail has no header of its own: its destructive clear is
      // contributed to the shared side-panel header by the active panel.
      const menu = page.locator(
        ".side-panel__action-group--content wa-dropdown.chat-session-rail__menu",
      );
      await run({ companion, gateway, menu, page });
    },
  );
}

async function clearCompanion(menu: Locator): Promise<void> {
  await menu.getByRole("button", { name: "More companion actions" }).click();
  await menu.locator('wa-dropdown-item[value="clear"]').click();
}

suite.define(() => {
  it("shows a reset failure without clearing the thread, then clears after a successful retry", async () => {
    await withCompanion(async ({ companion, gateway, menu, page }) => {
      await clearCompanion(menu);
      await gateway.waitForRequest("sessions.companion.reset");

      const alert = page.getByRole("alert").filter({ hasText: resetError });
      await alert.waitFor({ state: "visible" });
      await companion.getByText(answer, { exact: true }).waitFor();
      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "reset-failure.png"),
        });
      }

      await alert.getByRole("button", { name: "Dismiss error" }).click();
      await gateway.setMethodResponse("sessions.companion.reset", { ok: true });
      await clearCompanion(menu);

      await expect
        .poll(async () => (await gateway.getRequests("sessions.companion.reset")).length)
        .toBe(2);
      await expect.poll(() => companion.getByText(answer, { exact: true }).count()).toBe(0);
      expect(await page.getByRole("alert").count()).toBe(0);
      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "reset-success.png"),
        });
      }
    });
  });

  it("does not publish a delayed reset rejection into a newly selected session", async () => {
    await withCompanion(async ({ gateway, menu, page }) => {
      await gateway.deferNext("sessions.companion.reset");
      await clearCompanion(menu);
      await gateway.waitForRequest("sessions.companion.reset");

      await navigateToControlUiSession(page, nextSessionKey);
      await gateway.rejectDeferred("sessions.companion.reset", {
        code: "UNAVAILABLE",
        message: resetError,
      });

      const visiblePane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      expect(await visiblePane.getByRole("alert").filter({ hasText: resetError }).count()).toBe(0);
      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "stale-reset-error-suppressed.png"),
        });
      }

      await navigateToControlUiSession(page, initiatingSessionKey);
      const initiatingPane = page.locator("openclaw-chat-pane.chat-pane-cache__pane--visible");
      expect(await initiatingPane.getByRole("alert").filter({ hasText: resetError }).count()).toBe(
        0,
      );
      await initiatingPane
        .locator("openclaw-chat-session-rail")
        .getByText(answer, { exact: true })
        .waitFor();
      if (artifactDir) {
        await page.screenshot({
          fullPage: true,
          path: path.join(artifactDir, "initiating-thread-preserved.png"),
        });
      }
    });
  });
});

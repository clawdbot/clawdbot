import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "session companion clear",
  startServerBeforeBrowser: true,
});

const artifactDir = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
const answer = "Keep this companion answer visible until the reset succeeds.";

suite.define(() => {
  it("shows a reset failure without clearing the thread, then clears after a successful retry", async () => {
    if (artifactDir) {
      await mkdir(artifactDir, { recursive: true });
    }
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
              __mockError: {
                code: "UNAVAILABLE",
                message: "Companion reset unavailable during reconnect",
              },
            },
            "sessions.companion.state": {
              exchanges: [{ question: "What changed?", answer, ts: Date.now() - 1_000 }],
            },
          },
          sessionKey: "agent:main:companion-clear",
        });

        await page.goto(`${suite.server.baseUrl}chat`);
        const stateRequest = await gateway.waitForRequest("sessions.companion.state");
        expect(stateRequest.params).toEqual({
          agentId: "main",
          sessionKey: "agent:main:companion-clear",
        });
        const companion = page.locator("openclaw-chat-session-rail");
        await companion.locator(".chat-session-rail__expand").click();
        await companion.getByText(answer, { exact: true }).waitFor();

        const menu = companion.locator("wa-dropdown.chat-session-rail__menu");
        await menu.getByRole("button", { name: "More companion actions" }).click();
        await menu.locator('wa-dropdown-item[value="clear"]').click();
        await gateway.waitForRequest("sessions.companion.reset");

        const alert = page
          .getByRole("alert")
          .filter({ hasText: "Companion reset unavailable during reconnect" });
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
        await menu.getByRole("button", { name: "More companion actions" }).click();
        await menu.locator('wa-dropdown-item[value="clear"]').click();

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
      },
    );
  });
});

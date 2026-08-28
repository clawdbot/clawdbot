import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import {
  captureUiProof,
  sessionRow,
  sessionsListResponse,
} from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "missing session link",
  startServerBeforeBrowser: true,
});

suite.define(() => {
  it("keeps an explicitly requested missing session as a visible dead end", async () => {
    const mainKey = "agent:main:main";
    const attemptedPath = "/chat/main/deadbeef";
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.list": sessionsListResponse([sessionRow(mainKey, "Main", 1)]),
            "sessions.resolve": { ok: false },
          },
          sessionKey: mainKey,
        });

        await page.goto(`${suite.server.baseUrl}${attemptedPath.slice(1)}`);
        const state = page.locator(".session-route-not-found");
        await state.getByText("Session not found", { exact: true }).waitFor();
        expect(new URL(page.url()).pathname).toBe(attemptedPath);
        await state
          .getByText("The session may have been removed, or the link may be incorrect.", {
            exact: true,
          })
          .waitFor();
        const currentSession = state.getByRole("button", { name: "Go to main session" });
        const sessions = state.getByRole("button", { name: "View sessions" });
        expect(
          await currentSession.evaluate((element) => getComputedStyle(element).textDecorationLine),
        ).toBe("none");
        expect(
          await sessions.evaluate((element) => getComputedStyle(element).textDecorationLine),
        ).toBe("none");
        expect(
          await state
            .locator(".lazy-view-error__subtitle")
            .evaluate((element) => getComputedStyle(element).textWrap),
        ).toBe("balance");
        expect(await page.locator("openclaw-chat-page").count()).toBe(0);
        expect(await page.locator(".agent-chat__input textarea").count()).toBe(0);
        expect(await page.locator("openclaw-toast-host .app-toast").count()).toBe(0);
        expect(await gateway.getRequests("sessions.resolve")).toHaveLength(1);
        await captureUiProof(page, "session-link-not-found-after.png");

        await currentSession.click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/main");
        await page.locator(".agent-chat__input textarea").waitFor({ state: "visible" });

        await page.goto(`${suite.server.baseUrl}${attemptedPath.slice(1)}`);
        await page.getByRole("button", { name: "View sessions" }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe("/sessions");
        const sessionsHeader = page.locator("openclaw-sessions-page .sessions-hub-header");
        await sessionsHeader.waitFor({ state: "visible" });
        expect(await sessionsHeader.textContent()).toContain("Active sessions and defaults.");
      },
    );
  });
});

import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { captureUiProof, sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "missing session link",
  startServerBeforeBrowser: true,
});

async function rememberSession(page: Page, savedSessionKey: string) {
  await page.addInitScript(
    ({ gatewayUrl, settingsKey, sessionKey }) => {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          gatewayUrl,
          sessionsByGateway: { [gatewayUrl]: { sessionKey, lastActiveSessionKey: sessionKey } },
        }),
      );
    },
    {
      gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
      settingsKey: controlUiBundledSettingsStorageKey(suite.server.baseUrl),
      sessionKey: savedSessionKey,
    },
  );
}

suite.define(() => {
  it.each([
    ["missing session", "agent:main:15cf8259-0000-4000-8000-000000000001"],
    ["removed agent", "agent:retired:main"],
  ])("opens a usable main chat with a remembered %s", async (name, savedKey) => {
    const mainKey = "agent:main:main";
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, { sessions: [], mainSessionKey: mainKey });
        await rememberSession(page, savedKey);

        await page.goto(suite.server.baseUrl);
        await expect.poll(() => new URL(page.url()).pathname).toBe("/chat/main");
        const activeComposer = page.locator(
          'openclaw-chat-pane[aria-hidden="false"] .agent-chat__input textarea',
        );
        await activeComposer.waitFor({ state: "visible" });
        expect(await activeComposer.count()).toBe(1);
        expect(await page.locator(".session-route-not-found").count()).toBe(0);
        expect((await gateway.waitForRequest("chat.startup")).params).toMatchObject({
          sessionKey: mainKey,
        });
        await captureUiProof(suite, page, `remembered-${name.replaceAll(" ", "-")}.png`);
      },
    );
  });

  it("restores the exact remembered session when its short prefix collides", async () => {
    const key = "agent:main:thread:12345678-0000-4000-8000-000000000001";
    const otherKey = "agent:main:thread:12345678-0000-4000-8000-000000000002";
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        sessions: [],
        methodResponses: {
          "sessions.resolve": {
            cases: [
              { match: { key }, response: { ok: true, key, agentId: "main" } },
              {
                match: { shortId: "12345678" },
                response: {
                  ok: false,
                  candidates: [
                    { key, agentId: "main" },
                    { key: otherKey, agentId: "main" },
                  ],
                },
              },
            ],
          },
        },
      });
      await rememberSession(page, key);

      await page.goto(suite.server.baseUrl);
      await page.locator(".agent-chat__input textarea").waitFor({ state: "visible" });
      expect((await gateway.waitForRequest("chat.startup")).params).toMatchObject({
        sessionKey: key,
      });
      await expect.poll(() => new URL(page.url()).search).toBe("");
      const requests = await gateway.getRequests("sessions.resolve");
      expect(requests).toHaveLength(1);
      expect(requests[0]?.params).toMatchObject({ key, allowMissing: true });
    });
  });

  it("keeps an explicitly requested missing session as a visible dead end", async () => {
    const mainKey = "agent:main:main";
    const savedActiveKey = "agent:main:saved-active-session";
    const attemptedPath = "/chat/main/deadbeef";
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { height: 900, width: 1280 } },
      async ({ page }) => {
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "sessions.list": sessionsListResponse([sessionRow(mainKey, "Main", 1)]),
            "chat.startup": { resolution: { ok: false } },
          },
          mainSessionKey: mainKey,
          sessionKey: savedActiveKey,
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
        expect(await gateway.getRequests("chat.startup")).toHaveLength(1);
        expect(await gateway.getRequests("sessions.resolve")).toEqual([
          expect.objectContaining({
            params: expect.objectContaining({ reference: { key: "agent:main:deadbeef" } }),
          }),
        ]);
        await captureUiProof(suite, page, "session-link-not-found-after.png");

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

import { expect, it } from "vitest";
import {
  createNewSessionPageE2eSuite,
  installMockGateway,
} from "./new-session-page.test-support.ts";

const suite = createNewSessionPageE2eSuite();

suite.define(() => {
  it("keeps empty-state suggestions desktop-only across viewport changes", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": {
            count: 0,
            defaults: { contextTokens: null, model: null, modelProvider: null },
            path: "",
            sessions: [],
            ts: Date.now(),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      const suggestions = page.locator(".agent-chat__suggestion:visible");
      await expect.poll(() => suggestions.count()).toBe(4);

      await page.setViewportSize({ width: 390, height: 844 });
      await expect.poll(() => suggestions.count()).toBe(0);

      await page.setViewportSize({ width: 1280, height: 900 });
      await expect.poll(() => suggestions.count()).toBe(4);
    });
  });

  it("keeps recent sessions visible on phone layouts", async () => {
    await suite.withPage({ viewport: { width: 390, height: 844 } }, async ({ page }) => {
      await installMockGateway(page, {
        methodResponses: {
          "sessions.list": {
            count: 1,
            defaults: { contextTokens: null, model: null, modelProvider: null },
            path: "",
            sessions: [
              {
                key: "agent:main:dashboard:recent",
                kind: "direct",
                label: "Recent work",
                updatedAt: Date.now(),
              },
            ],
            ts: Date.now(),
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await expect.poll(() => page.locator(".agent-chat__recent").count()).toBe(1);
      await expect.poll(() => page.locator(".agent-chat__recent").isVisible()).toBe(true);
    });
  });
});

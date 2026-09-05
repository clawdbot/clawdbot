import { expect, it } from "vitest";
import { waitForControlUiRoute } from "../test-helpers/control-ui-e2e.ts";
import {
  captureNewSessionComposerUiProof,
  createNewSessionPageE2eSuite,
  installMockGateway,
  waitForGatewayRecoveryScope,
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

  it("keeps selected people and their remove control compact on a cold New Session", async () => {
    await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
      const gateway = await installMockGateway(page, {
        presenceUsers: [
          {
            self: true,
            id: "profile-alice",
            identity: { type: "profile", id: "profile-alice" },
            name: "Alice",
          },
        ],
        methodResponses: {
          "users.mentionable": {
            users: [{ profileId: "profile-bob", displayName: "Bob", online: true }],
            truncated: false,
          },
        },
      });

      await page.goto(`${suite.server.baseUrl}new`);
      await waitForControlUiRoute(page, { pathname: "/new", routeId: "new-session" });
      await waitForGatewayRecoveryScope(page);
      const textarea = page.locator(".new-session-page__message");
      await textarea.pressSequentially("@Bob");
      expect((await gateway.waitForRequest("users.mentionable")).params).toMatchObject({
        agentId: "main",
      });
      await page.getByRole("option", { name: /Bob/ }).click();
      const preview = page.locator(".new-session-page__composer .chat-reply-preview");
      await expect.poll(() => preview.textContent()).toContain("Will notify: @Bob");
      const remove = preview.getByRole("button", { name: "Remove mention" });

      for (const viewport of [
        { width: 1280, height: 900 },
        { width: 390, height: 844 },
      ]) {
        await page.setViewportSize(viewport);
        await captureNewSessionComposerUiProof(
          suite,
          page,
          `cold-mention-selection-${viewport.width}.png`,
        );
        const layout = await preview.evaluate((element) => {
          const bar = element.getBoundingClientRect();
          const text = element.querySelector(".chat-reply-preview__text")!.getBoundingClientRect();
          const button = element.querySelector("button")!.getBoundingClientRect();
          return {
            height: bar.height,
            textBeforeButton: text.right <= button.left,
            sameRow: Math.abs(text.top + text.height / 2 - button.top - button.height / 2) <= 1,
            buttonContained:
              button.left >= bar.left &&
              button.right <= bar.right &&
              button.top >= bar.top &&
              button.bottom <= bar.bottom,
            iconSizes: [...element.querySelectorAll("svg")].map((icon) => {
              const bounds = icon.getBoundingClientRect();
              return Math.max(bounds.width, bounds.height);
            }),
          };
        });
        expect(layout.height).toBeLessThanOrEqual(48);
        expect(layout).toMatchObject({
          textBeforeButton: true,
          sameRow: true,
          buttonContained: true,
        });
        for (const size of layout.iconSizes) {
          expect(size).toBeGreaterThan(0);
          expect(size).toBeLessThanOrEqual(24);
        }
        await expect.poll(() => remove.isVisible()).toBe(true);
      }

      await remove.click();
      await expect.poll(() => preview.count()).toBe(0);
      expect(await textarea.inputValue()).toBe("@Bob ");
      await captureNewSessionComposerUiProof(suite, page, "cold-mention-removed.png");
    });
  });
});

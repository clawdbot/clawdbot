import { expect, it } from "vitest";
import {
  chatSessionListResponse,
  controlUiSessionUrl,
  createChatFlowE2eSuite,
  installMockGateway,
} from "./chat-flow.test-support.ts";
import { createControlUiE2eContextOptions } from "./control-ui-e2e-suite.test-support.ts";

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("shows the selected permission and disables dropdown motion when requested", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      reducedMotion: "reduce",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const session = {
      key: "agent:main:session-a",
      kind: "direct",
      label: "Session A",
      permissionMode: "guarded",
      updatedAt: 2,
    };
    await installMockGateway(page, {
      methodResponses: { "sessions.list": chatSessionListResponse([session]) },
      sessionKey: session.key,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, session.key));
      const pane = page.locator('openclaw-chat-pane[aria-hidden="false"]');
      const picker = pane.locator(".chat-controls__permission-picker");
      await pane.locator('[data-chat-permission-select="true"]').click();
      await pane.locator('[data-chat-permission-option="default"]').waitFor({ state: "visible" });

      const [selectedBackground, unselectedBackground, showDuration, hideDuration] =
        await Promise.all([
          pane
            .locator('[data-chat-permission-option="guarded"]')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
          pane
            .locator('[data-chat-permission-option="workspace"]')
            .evaluate((element) => getComputedStyle(element).backgroundColor),
          picker.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).getPropertyValue("--show-duration")),
          ),
          picker.evaluate((element) =>
            Number.parseFloat(getComputedStyle(element).getPropertyValue("--hide-duration")),
          ),
        ]);
      expect(selectedBackground).not.toBe(unselectedBackground);
      expect(showDuration).toBe(0);
      expect(hideDuration).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("animates inline pickers from their placed edge and honors reduced motion", async () => {
    const context = await suite.newBrowserContext(createControlUiE2eContextOptions());
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      models: Array.from({ length: 12 }, (_, index) => ({
        id: `model-${index + 1}`,
        name: `Model ${index + 1}`,
        provider: "openai",
      })),
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await gateway.waitForRequest("chat.startup");
      const control = page.locator(".chat-composer-model-control");

      for (const picker of [
        {
          popup: ".chat-controls__model-picker > wa-popup",
          trigger: '[data-chat-model-select="true"]',
        },
        {
          popup: ".chat-controls__effort-picker > wa-popup",
          trigger: '[data-chat-thinking-select="true"]',
        },
      ]) {
        await page.emulateMedia({ reducedMotion: "no-preference" });
        await page.setViewportSize({ height: 900, width: 1280 });
        await control.evaluate((element) => {
          Object.assign((element as HTMLElement).style, {
            position: "fixed",
            right: "80px",
            top: "640px",
          });
        });
        const trigger = control.locator(picker.trigger);
        const popup = control.locator(picker.popup);
        await trigger.click();
        await expect.poll(() => popup.getAttribute("data-current-placement")).toMatch(/^top/u);

        const topMotion = await popup.evaluate((element) => {
          const surface = element.shadowRoot?.querySelector<HTMLElement>('[part~="popup"]');
          if (!surface) {
            return null;
          }
          const style = getComputedStyle(surface);
          return {
            animationName: style.animationName,
            height: surface.offsetHeight,
            originY: Number.parseFloat(style.transformOrigin.split(" ")[1] ?? ""),
          };
        });
        expect(topMotion?.animationName).toBe("chat-composer-picker-in");
        expect(topMotion?.originY).toBeCloseTo(topMotion?.height ?? -1, 0);

        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(
          await popup.evaluate((element) => {
            const surface = element.shadowRoot?.querySelector<HTMLElement>('[part~="popup"]');
            return surface ? getComputedStyle(surface).animationName : null;
          }),
        ).toBe("none");

        await page.setViewportSize({ height: 320, width: 1280 });
        await control.evaluate((element) => {
          (element as HTMLElement).style.top = "24px";
        });
        await expect.poll(() => popup.getAttribute("data-current-placement")).toMatch(/^bottom/u);
        expect(
          await popup.evaluate((element) => {
            const surface = element.shadowRoot?.querySelector<HTMLElement>('[part~="popup"]');
            return surface
              ? Number.parseFloat(getComputedStyle(surface).transformOrigin.split(" ")[1] ?? "")
              : null;
          }),
        ).toBeCloseTo(0, 0);
        await trigger.click();
      }
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
